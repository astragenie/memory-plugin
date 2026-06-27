# AstraMemory Local v1 — Design

**Date:** 2026-06-27
**Status:** Draft for review
**Source:** Critique of GitHub issues #4-#7 (4-part OpenAI roadmap) + brainstorming session
**Repo for spec:** astramemory-plugin (current)
**Repo for implementation:** new sibling `astramemory-local`

---

## 1. Vision

Local-first memory daemon for AI coding agents. Wire-compatible with the existing `memory-plugin` so the plugin can be redirected from the SaaS endpoint to a local daemon by changing one environment variable. Captures transcripts, distills typed memories, serves hybrid search (FTS5 + vector). Runs on Linux, macOS, Windows as a user-scope service.

v1 scope = Milestones 1-4 of the OpenAI roadmap (storage, pipeline, distillation, hybrid search). Milestones 5-8 (CLI/installer beyond minimum, knowledge graph, SaaS sync) are deferred.

## 2. Non-goals (v1)

Items dropped from the OpenAI plan after critical review:

- Knowledge graph and entity relationships (M7).
- SaaS sync, team broker, organization policy (M8).
- Multiple embeddings per memory (natural, entity-rich, keyword-rich, repo-aware, question-oriented).
- Reranking provider.
- Memory versioning / supersedes graph.
- 22-type memory taxonomy.
- Topic segmentation stage.
- LLM-based quality scoring stage.
- Capabilities API on provider abstraction.
- Cross-machine sync, encrypted backup.
- Multi-agent self-improvement, forgetting, contradiction resolution.

If any of these prove necessary after v1 ships, they enter the backlog with measured justification.

## 3. Repository layout

```
astramemory-local/
├── package.json
├── bin/astra-memory                 # CLI dispatcher
├── src/
│   ├── server/                      # Fastify HTTP daemon
│   ├── storage/                     # SQLite + migrations + repositories
│   ├── vector/                      # sqlite-vec adapter + LanceDB stub
│   ├── pipeline/                    # job table, worker loop, state machine
│   ├── distill/                     # 8 stage modules
│   ├── providers/
│   │   ├── llm/{ollama,azure-openai}.ts
│   │   └── embed/{ollama,azure-openai}.ts
│   ├── search/                      # hybrid score fusion
│   ├── service/                     # per-OS install adapters
│   ├── budget/                      # daily spend tracker
│   ├── doctor/                      # health checks
│   └── config/                      # layered config loader + wizard
├── migrations/*.sql
├── docs/
└── tests/
```

## 4. Components and data flow

```
existing memory-plugin hooks (unchanged)
   │  POST /ingest/transcript
   │  MEMORY_API_URL=http://127.0.0.1:7777
   ▼
HTTP daemon ───────► SQLite (sessions, jobs)
                       │
                       ▼
                    Worker loop ───► 8-stage distillation ───► memories + embeddings
                                                                     │
                                                                     ▼
                                                              SQLite + sqlite-vec + FTS5
                                                                     ▲
                                                                     │
plugin /recall ─► GET /search ─► hybrid (BM25 + cosine + filters) ───┘
```

Single Node process. Workers run in-process on a polling loop. SQLite is the source of truth. Everything derived (vectors, FTS rows, compactions) can be rebuilt by replaying jobs.

## 5. SQLite schema (core)

```sql
-- conversation layer
sessions(id TEXT PRIMARY KEY, repo, project, branch, agent, started_at, ended_at);
messages(id, session_id, role, content, ts, kind);          -- raw turns
transcripts(id, session_id, source, content, ingested_at);

-- memory layer
memories(
  id TEXT PRIMARY KEY,
  type TEXT CHECK(type IN ('decision','fact','lesson','command','todo')),
  text TEXT,
  normalized_text TEXT,
  repo, project, branch, agent, session_id,
  importance REAL DEFAULT 0.5,
  confidence REAL DEFAULT 0.5,
  hash TEXT,                                                -- dedup
  embedding_provider TEXT,
  embedding_model TEXT,
  embedding_dim INTEGER,
  created_at, updated_at, source_hash
);
memories_fts USING fts5(text, normalized_text, content='memories');
memories_vec USING vec0(embedding FLOAT[1024]);

-- pipeline layer
jobs(
  id, kind TEXT, payload_json TEXT,
  state TEXT CHECK(state IN ('pending','running','completed','failed','poison','paused')),
  attempts INTEGER DEFAULT 0,
  last_error TEXT,
  created_at, updated_at
);
artifacts(id, job_id, kind, content_path, created_at);

-- meta
schema_version(version INTEGER PRIMARY KEY, applied_at);
provider_state(provider, model, dim, last_health_ok, last_check_at);
budget_spend(day TEXT PRIMARY KEY, usd_total REAL, calls INTEGER);
```

No knowledge-graph tables. No supersedes columns. No multi-vec columns. Add only when measured retrieval pain forces it.

## 6. Provider interfaces (minimal)

```ts
interface LLMProvider {
  name: 'ollama' | 'azure-openai';
  chat(messages: Msg[], opts: {temperature?: number, json?: boolean, maxTokens?: number}): Promise<{text: string, usage: {in: number, out: number, usd: number}}>;
  health(): Promise<{ok: boolean, model: string, latency_ms: number}>;
}

interface EmbedProvider {
  name: 'ollama' | 'azure-openai';
  model: string;
  dim: 1024;                                  // pinned system-wide
  embed(texts: string[]): Promise<Float32Array[]>;
  health(): Promise<{ok: boolean}>;
}

interface VectorStore {
  name: 'sqlite-vec' | 'lancedb';
  upsert(id: string, vec: Float32Array): Promise<void>;
  search(vec: Float32Array, k: number, filter?: SqlFilter): Promise<{id: string, score: number}[]>;
  rebuild(): Promise<void>;
}
```

Two real LLM and two real Embed implementations force a real interface. No `capabilities()`, no `batch()`, no rate-limit metadata. Add when a third provider arrives.

## 7. Provider selection rules

- LLM provider for compaction and extraction may be configured independently per stage. Text-in, text-out, no shared state — swap freely.
- Embedding provider is configured once, system-wide. Switching provider triggers a `rebuild --reembed` job. Doctor refuses startup if memory rows reference a model that differs from the configured one.
- Vector dimension pinned at 1024 in v1. Both Ollama nomic-embed-text-v2-moe (1024 native) and Azure text-embedding-3-small (configured to 1024 via the `dimensions` parameter) hit it.

**Why same dim is not enough:** different embedding models produce vectors in different geometric spaces. Cosine distance between vectors from two models is meaningless. Single model per index is a correctness requirement, not a preference.

## 8. Capture path

Wire-compatible swap. The existing plugin hooks (`hooks/scripts/*.sh`) already POST to `${MEMORY_API_URL}/ingest/transcript`. Setting `MEMORY_API_URL=http://127.0.0.1:7777` redirects them to the local daemon. Plugin code unchanged. Same `Bearer` header pattern.

**Local token lifecycle:**
- `astra-memory init` generates a 32-byte random hex token, stores at `~/.config/astra-memory/secrets.env` mode 0600 as `MEMORY_BEARER=...`.
- Wizard prints `export MEMORY_BEARER=...` line for user to add to shell rc.
- Daemon reads same file at boot, accepts only matching token.
- `astra-memory token rotate` issues a new one (invalidates prior); user re-exports.
- Doctor refuses startup if config binds non-loopback without `--allow-network`.

Endpoints exposed:

```
POST /ingest/transcript          # wire-compat with current plugin
GET  /search?q=&type=&repo=&since=&limit=
POST /recall                     # body: {query, k, filters}
POST /remember                   # body: {text, type, metadata}
GET  /memory/:id
GET  /health
```

## 9. Distillation pipeline (8 stages)

```
ingest stored → enqueue job(kind=distill, session_id)
  ↓ worker
1. cleanup           free   regex dedup whitespace, repeated tool output
2. normalize         free   paths, timestamps, agent names
3. chunk             free   token + turn-boundary ~800 tokens
4. compact           LLM    Qwen 2.5 Coder 7B OR GPT-4.1 per config
5. extract           LLM    JSON-mode, 5 typed atoms (decision/fact/lesson/command/todo)
6. reduce            free   hash-merge dupes across chunks
7. memory-normalize  free   canonical text, lowercase entity dictionary
8. dedupe + embed + index
                     embed  Float32Array[1024]
                     free   insert memories + fts + vec rows
```

Per session estimate (50 turns, 5 chunks, ~15 atoms): 10 LLM calls + 15 embed calls. Worker is idempotent — same `session_id + source_hash` short-circuits.

Skipped from the OpenAI plan (with rationale):

- Topic segmentation — extra LLM call, marginal gain when chunks are turn-boundary-aware.
- Quality scoring — rule-based importance/confidence in v1 (length, type, recency). Add LLM scorer in v1.1 only if recall metric demands it.

## 10. Search and recall

```
POST /search (or /recall)
  parse: q, type, repo, project, branch, since, limit
  ↓ parallel
    ├── FTS5 BM25 query → [{id, bm25}]
    └── embed(q) → vec.search() → [{id, cosine}]
  ↓
  fuse: score = α·norm(bm25) + β·norm(cosine) + γ·importance + δ·freshness
  ↓
  apply filters, top-k, join memories, return
```

Defaults: α=β=0.4, γ=0.1, δ=0.1. Config-overridable. No reranker.

`/recall` is `/search` with k=5, type=any, repo defaulted from caller header. `/remember` skips the distillation pipeline — direct insert (used by `astra-memory remember` CLI for explicit user-authored memories).

## 11. CLI surface

```
astra-memory init                  # interactive wizard (see §13)
astra-memory serve [--port N]      # foreground daemon
astra-memory service install       # per-OS unit install
astra-memory service status|start|stop|uninstall
astra-memory doctor                # checks (see §15)
astra-memory search "query" [--type --repo --since --limit]
astra-memory recall "question"
astra-memory remember "text" [--type --tags]
astra-memory queue [--state failed]
astra-memory rebuild [--reembed]
astra-memory providers list
astra-memory providers test [name]
astra-memory budget                # show today + month spend vs cap
astra-memory token rotate          # issue new local Bearer
```

## 12. Daemon lifecycle — per-OS service install

User-scope, no admin/UAC.

- **Linux:** write `~/.config/systemd/user/astra-memoryd.service`, run `systemctl --user enable --now astra-memoryd`.
- **macOS:** write `~/Library/LaunchAgents/com.astragenie.astra-memoryd.plist`, run `launchctl bootstrap gui/$UID`.
- **Windows:** `schtasks /create /sc onlogon /tn AstraMemoryD /tr "node ... serve"` (no UAC since user-scope task).

All point to `astra-memory serve --port $PORT`. Foreground `astra-memory serve` remains available for dev. `astra-memory service install` is one-shot — the unit then survives reboots.

## 13. Installer wizard (M5)

```
$ astra-memory init

? Vector store:           ❯ sqlite-vec (recommended)
                            lancedb
? Embedding provider:     ❯ ollama (local, free)
                            azure-openai (cloud, ~$0)
? LLM provider:           ❯ ollama (qwen2.5-coder:7b)
                            azure-openai (gpt-4.1)
? Data directory:         (~/.local/share/astra-memory)
? Daemon port:            (7777)
? Daily LLM budget cap:   ($10 USD)
? Install as service?     (Y/n)

→ Conditional checks per choice:
  - ollama selected   → `which ollama`, GET :11434/api/tags, model present
                        offer `ollama pull <model>` command
  - azure selected    → prompt endpoint, deployment, api-key
                        write to ~/.config/astra-memory/secrets.env (0600)
                        ping deployment with 1-token request to confirm
  - lancedb selected  → `npm install @lancedb/lancedb` + arch check
  - sqlite-vec        → bundled, no check

→ Write config.yaml, run migrations, run doctor, print next steps.
```

Stack: `@inquirer/prompts`, `which`, native `fetch`, `node:fs/promises`.

## 14. Budget enforcement

Chat-stage cost only — embeddings are noise (~$0.0001/day at typical volume).

- Daily cap default: **$10 USD**. Configurable in `config.yaml`.
- Each LLM provider's `chat()` returns `usage.usd` (Azure via response usage + pricing table; Ollama always 0).
- `budget_spend` table tracks per-day total.
- Worker checks cap before each LLM call. Over cap → job goes to `paused` state (not `failed`). Doctor reports "budget exceeded, distillation paused".
- Capture endpoint still accepts ingest (no cost). Distillation backs off until next UTC day OR user runs `astra-memory budget --reset` (override).
- 80% threshold → warning logged. 100% → pause.

## 15. Doctor checks (slim)

- SQLite writable, WAL on.
- `sqlite-vec` extension loadable. FTS5 available.
- Daemon reachable on configured port.
- Configured LLM provider responds (chat ping ≤ 5s).
- Configured embed provider returns 1024-dim test vector.
- Pipeline queue not stuck (no jobs in `running` > 1h).
- Disk free > 1GB in datadir.
- Service unit present and active (if installed).
- Today's budget vs cap.
- Memory provider mismatch — if any memory row's `embedding_model` differs from configured: warn in `doctor`, **block** distillation worker until `rebuild --reembed` completes. Reads still work (vec rows are valid for prior memories within their own space, but new memories must use current model).

Output: human-readable table, exit-0 if all green, exit-1 if any red. JSON mode (`--json`) for CI.

## 16. Testing strategy

- **Unit:** each distillation stage with fixture transcript.
- **Provider contract:** both LLM impls share a test suite (same inputs → both return valid `{text, usage}`). Same for embed impls (1024-dim, normalized).
- **Integration:** ingest fixture transcript via HTTP → assert N memories created + search returns them.
- **E2E:** spin daemon in subprocess, plugin's existing hook script POSTs, assert /search returns.
- **Cross-OS install:** GitHub Actions matrix (ubuntu / macos / windows) installs sqlite-vec native, runs ingest+search.

## 17. Risks and open questions

| # | Risk | Mitigation |
|---|------|-----------|
| 1 | sqlite-vec native binary on Windows | Test in CI matrix on day 1 of M1. Vendored prebuilts under `bin/`. |
| 2 | Qwen 2.5 Coder JSON-mode unreliable in Ollama | Wrap extraction prompt with Zod schema, retry once with stricter prompt, fall back to `decision:` keyword pre-tagging. |
| 3 | Azure API key in plain config | Write to `secrets.env` mode 0600. Future: OS keychain via `keytar`. |
| 4 | Plugin double-runs (remote + local) | Doctor reads plugin's `.mcp.json` and `MEMORY_API_URL` env, warns on ambiguity. |
| 5 | Reindex on provider switch is heavy | Background job, progress reported via `/queue`. CLI shows ETA. |
| 6 | Budget cap evasion if user keeps resetting | Log every override. v1.1: monthly cap on top of daily. |
| 7 | Distillation lag — atoms not searchable until worker drains | Acceptable for v1; document in README. Workers run continuously, typical lag < 30s. |
| 8 | Loopback-only auth — what if user binds 0.0.0.0 | Default binds 127.0.0.1. Doctor refuses startup if config sets `0.0.0.0` without explicit `--allow-network`. |

## 18. Milestone sequence and estimate

Single dev, focused work.

| Milestone | Work | Estimate |
|---|---|---|
| **M1 storage** | SQLite + migrations + repos + FTS5 + sqlite-vec wire-up + raw transcript ingest endpoint + minimal `astra-memory serve` | 1 week |
| **M2 pipeline** | Job table + worker loop + state machine + retries + idempotency + cleanup worker | 1-1.5 weeks |
| **M3 distillation** | 8 stages + 2 LLM providers + 1 embed provider + 5-type extraction prompt + Zod validation + budget tracking + tests | 2-3 weeks |
| **M4 search** | Hybrid score fusion + filters + `/search` + `/recall` + CLI search/recall + scoring config | 1 week |
| **M5 install + wizard + service + doctor** | Interactive `init` wizard + per-OS service install + doctor checks + budget command + cross-OS CI | 1 week |
| **Total** | | **~6-7 weeks** |

Cut criteria if behind:

- Drop Azure provider — Ollama-only v1. Saves ~3 days of provider impl + budget logic.
- Drop compaction stage — extract directly from raw chunks. Halves LLM cost, ~10% quality hit.
- Defer LanceDB stub interface — wire sqlite-vec directly, add provider abstraction in v1.1.

## 19. Reuse from current plugin

- HTTP ingest contract — already defined in `hooks/scripts/_ingest-transcript.sh` (POST shape, retry budget, scrub envelope).
- Bearer auth pattern — daemon mints a local token at first `init`, plugin uses same `MEMORY_BEARER` env.
- Test fixtures from existing `tests/*.test.mjs` — reuse for contract tests.

## 20. Conflicts to remove

- None in plugin repo. New repo only.
- README of plugin gains a `## Local backend` section pointing at local repo and noting env-swap.

## 21. Out-of-scope clarifications

If user asks about features explicitly skipped:

- **Knowledge graph** → "Stored as flat memories in v1. Entity extraction and relationships land in v1.1 if recall data shows need."
- **SaaS sync** → "Local is standalone. Sync to AstraMemory SaaS is a separate workstream — different repo, different priority."
- **22 memory types** → "v1 ships 5 core types. Others available as `tags` on flat memories until type-specific ranking proves value."
- **Reranker** → "Hybrid fusion (BM25 + cosine + importance + freshness) covers v1. Cross-encoder reranker is v1.1 or later."

## 22. Approval gates

1. This design reviewed by user → approve / request changes.
2. Implementation plan written via writing-plans skill.
3. Repo scaffolded under new path.
4. Each milestone has a PR with tests + doctor passing before next milestone starts.

---

**End of design.**
