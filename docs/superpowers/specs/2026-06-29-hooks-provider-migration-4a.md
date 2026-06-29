# FEAT 4a: Hooks Migration to Provider Plane (v0.6.0)

**Date:** 2026-06-29
**Status:** Architect-reviewed; awaiting build
**Predecessor:** v0.5.0 (Wave 3 — slash-cmd migration to Bun CLI + provider selector)
**Successor:** FEAT 4b — MCP Migration (separate file, v0.6.1+)
**Target version:** v0.6.0
**Architect verdict:** Endorsed scope, split applied. Review summary in session transcript.

---

## 1. Problem

Wave 3 (v0.4.0 → v0.5.0) migrated `/astramem:recall` and `/astramem:remember` slash commands to the new `bin/astramem` Bun CLI, which routes through `src/lib/selector.ts` → `LocalProvider | SaasProvider`. Auto-capture hooks were left on the legacy shell-script plane.

### 1.1 Affected hooks

`hooks/scripts/_load-env.sh` + `_ingest-transcript.sh` resolve `ASTRAMEMORY_API_URL` (defaults to `http://localhost:5201` — old cortex-style endpoint) and `ASTRAMEMORY_API_KEY` from `~/.astramemory/profiles.json` / `tokens.<env>.json`. They bypass:

- `src/lib/selector.ts` provider precedence chain
- `LocalProvider` HTTP semantics (retries, 4xx/5xx mapping, timeouts)
- `src/lib/secrets.ts` bearer read from `<unifiedConfigDir>/secrets.env`
- `src/lib/scrub.ts` bearer regex applied at every log sink
- `src/lib/log.ts` rotating ingest log

Fresh install with daemon at `:7777` → hooks fire against wrong URL → silent failure or ingest into wrong backend.

### 1.2 Scope of this FEAT

**In scope:** PreCompact, SessionEnd, SubagentStop hooks → migrate to `bin/astramem ingest-transcript` Bun CLI shim. Env-var consolidation.

**Out of scope (deferred to FEAT 4b):** `.mcp.json` server wiring. MCP migration has different risk envelope (long-lived process, protocol correctness, latency budget) and design space (Options A/B/C per FEAT 4b). Bundling it with hooks would stall a low-risk migration on an unresolved MCP design.

## 2. Goal

Hooks call `bin/astramem ingest-transcript` over a defined wire contract; bearer + URL resolved by selector + secrets reader; scrub + log handled by existing CLI sinks. Fresh install with daemon at `:7777` → hooks auto-route to local daemon with zero env-var setup.

## 3. Non-goals (v0.6.0)

- MCP server changes — see FEAT 4b
- New backend features
- Schema changes to recall/remember/health endpoints
- Removal of legacy `ASTRAMEMORY_*` env vars (kept through ≥v0.8.0, ideally v1.0.0)
- Removal of legacy `_load-env.sh` + `_ingest-transcript.sh` shell scripts (kept behind `MEMORY_LEGACY_HOOKS=1` opt-in for one release)
- SaaS bearer-refresh path inside hook ingest (deferred to v0.7.0 — see §4.1.2)

## 4. Proposed design

### 4.0 Prerequisites (DONE)

P0 bug from architect review:
- `src/providers/local.ts` previously imported `readLocalBearer` from root `lib/secrets.ts` stub (env-var only, async) instead of `src/lib/secrets.ts` (file-aware, sync).
- Fix shipped in commit `609ba1f` (2026-06-29): import swap, root stub deleted, hermetic datadir mock added to provider test.
- LocalProvider now genuinely reads `<unifiedConfigDir>/secrets.env`. Hook migration premise (the CLI does selector + secrets + scrub + log) is now true.

### 4.1 Hook migration

Replace `hooks/scripts/pre-compact-capture.sh`, `session-end-summary.sh`, `subagent-stop-capture.sh` with thin shims that call `bin/astramem ingest-transcript` (new subcommand — see §4.1.1). The CLI handles selector, secrets, scrub, log, retry. Legacy `_load-env.sh` + `_ingest-transcript.sh` retained behind `MEMORY_LEGACY_HOOKS=1` env gate for one release as rollback path (see §6.5).

#### 4.1.1 Transcript wire contract — new subcommand

The existing `bin/astramem ingest --json <IngestPayload>` accepts `{id, type, text, ...}` per `src/contracts/wire.ts`. Hook bodies are **structurally disjoint** — they are transcript envelopes with `{event, session_id, project_id, agent_type, cwd, captured_at, turns[], client_scrub_applied, client_scrub_hits, client_version}`. The current `_ingest-transcript.sh` does jq filtering, file read, role projection, tail, per-turn scrub, envelope construction, retry budget.

**Decision:** add a new subcommand `bin/astramem ingest-transcript` rather than overloading `ingest`. Rationale: discriminated payloads + separate Zod schema + separate test surface + independent retry/timeout policy.

New schema `TranscriptIngestPayloadSchema` in `src/contracts/wire.ts`:

```ts
export const TranscriptTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  ts: z.string().optional(),  // ISO-8601 if present
});

export const TranscriptIngestPayloadSchema = z.object({
  event: z.enum(['pre_compact', 'session_end', 'subagent_stop']),
  session_id: z.string(),
  project_id: z.string(),
  agent_type: z.string().optional(),
  cwd: z.string().optional(),
  captured_at: z.string(),  // ISO-8601
  turns: z.array(TranscriptTurnSchema),
  client_scrub_applied: z.boolean(),
  client_scrub_hits: z.number().int().nonnegative(),
  client_version: z.string(),
});
```

CLI surface:

```bash
bun bin/astramem ingest-transcript \
  --event pre_compact \
  --transcript-path /path/to/transcript.jsonl \
  --session-id <id> \
  --project-id <id> \
  --agent-type <type> \
  --cwd <path> \
  --max-turns 20 \
  --max-chars 12000
```

Implementation file: `src/cli/ingest-transcript.ts`. Reads transcript JSONL from disk, filters `role∈{user,assistant}`, tails to `--max-turns`, applies `src/lib/scrub.ts` per turn, builds envelope, POSTs to `LocalProvider.ingest()` (which already targets `/ingest/transcript`). Inherits provider's retry-once on transient + 4xx absorb + 5xx absorb (fire-and-forget contract).

Daemon-side: `/ingest/transcript` endpoint already exists per `src/providers/local.ts:122` — no daemon change required.

Hook shim shape (example for pre-compact):

```bash
#!/usr/bin/env bash
# pre-compact-capture.sh (new)
set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Legacy fallback — kept for one release as documented rollback path.
if [ "${MEMORY_LEGACY_HOOKS:-0}" = "1" ]; then
  export ASTRAMEMORY_HOOK_SCRIPT_NAME="pre-compact-capture-legacy"
  . "$SCRIPT_DIR/_load-env.sh"
  exec "$SCRIPT_DIR/_ingest-transcript.sh" \
    --event pre_compact \
    --max-turns "${MEMORY_PRECOMPACT_MAX_TURNS:-20}" \
    --max-chars "${MEMORY_PRECOMPACT_MAX_CHARS:-12000}"
fi

# Read hook stdin payload, extract fields with jq.
PAYLOAD="$(cat)"
TRANSCRIPT_PATH="$(printf '%s' "$PAYLOAD" | jq -r '.transcript_path // empty')"
SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // "unknown"')"
CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty')"
AGENT_TYPE="$(printf '%s' "$PAYLOAD" | jq -r '.agent_type // empty')"
PROJECT_ID="$(basename "${CWD:-$PWD}")"

exec bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" ingest-transcript \
  --event pre_compact \
  --transcript-path "$TRANSCRIPT_PATH" \
  --session-id "$SESSION_ID" \
  --project-id "$PROJECT_ID" \
  --agent-type "$AGENT_TYPE" \
  --cwd "$CWD" \
  --max-turns "${MEMORY_PRECOMPACT_MAX_TURNS:-20}" \
  --max-chars "${MEMORY_PRECOMPACT_MAX_CHARS:-12000}"
```

CHANGELOG note: hooks now require Bun (same requirement as slash commands since v0.4.0). Windows users without WSL get **better** behavior post-migration — no bash transcript-shaping path; bash wrapper is minimal jq extraction.

#### 4.1.2 SaaS bearer refresh — punted to v0.7.0

`_ingest-transcript.sh:94` calls `${CLAUDE_PLUGIN_ROOT}/bin/memory-refresh` (Clerk-backed OIDC) and prefers its output over `ASTRAMEMORY_API_KEY`. `SaasProvider` does NOT call `memory-refresh` internally today. Migrating hooks to `SaasProvider` would silently regress SaaS ingest to whatever static `MEMORY_BEARER` happens to be set.

**Decision:** v0.6.0 hook ingest against SaaS uses static bearer only. v0.7.0 adds OIDC refresh inside `SaasProvider` (separate FEAT). Doc note in v0.6.0 CHANGELOG + README troubleshooting.

### 4.2 Env-var consolidation

Canonical set in `src/lib/config.ts`:

| Purpose | Canonical | Legacy aliases (warn in v0.6.0; remove ≥v0.8.0) |
|---|---|---|
| Local daemon URL | `MEMORY_API_URL_LOCAL` | `ASTRAMEMORY_API_URL` (if value matches `:7777` pattern) |
| SaaS URL | `MEMORY_API_URL_SAAS` | `MEMORY_API_URL`, `ASTRAMEMORY_API_URL` (non-local) |
| Provider hint | `ASTRAMEM_PROVIDER` | — |
| Bearer (local) | `<unifiedConfigDir>/secrets.env` MEMORY_BEARER= | `MEMORY_BEARER` env, `ASTRAMEMORY_API_KEY` env |
| Bearer (SaaS) | `bin/memory-refresh` (Clerk OIDC) or OS keyring via `src/lib/secrets.ts` | `MEMORY_BEARER` env, `ASTRAMEMORY_API_KEY` env |

CLI startup emits one-line stderr warning if legacy var detected. Suppress with `MEMORY_DEPRECATION_OPT_OUT=1`. Count deprecation hits in `astramem doctor` output so user has visibility before removal.

## 5. Test plan

### 5.1 Unit + contract

- `tests/contracts/transcript-wire.test.ts` — `TranscriptIngestPayloadSchema` round-trip + reject malformed
- `tests/cli/ingest-transcript.test.ts` — new CLI subcommand: arg parsing, transcript-file read, role filter, tail, scrub call count, envelope construction, exit 0 on success + on provider failure (fire-and-forget contract preserved)
- `tests/lib/config-aliases.test.ts` — legacy env-var aliases resolve to canonical + one-time stderr warning + `MEMORY_DEPRECATION_OPT_OUT=1` suppresses

### 5.2 Hook payload fixture corpus (BLOCKING for merge)

Capture 5–10 representative hook payloads from `.claude/logs/payloads/*subagent_stop.json`, `*pre_compact*`, `*session_end*` and pin as fixtures in `tests/hooks/fixtures/`. For each fixture:

- Golden expected wire body (the envelope the CLI must build)
- Golden expected jq extraction values (session_id, cwd, etc.)
- Test: run the new bash shim against fixture stdin → assert byte-identical envelope vs golden (excluding `captured_at` timestamp + `client_version`)

Migration is NOT done until every fixture passes. Without this, contract drift is undetectable and user finds out only when recall returns wrong results.

### 5.3 Scrub parity (BLOCKING for merge)

Feed 100 known-secret strings (JWT, AWS key, Anthropic key, generic `api_key=`, plus innocuous control set) through both:
- `_ingest-transcript.sh --scrub-only` (POSIX BRE/ERE)
- `src/lib/scrub.ts` (JS regex)

Assert identical output for every input. The four shell-script patterns use POSIX regex; JS is not guaranteed equivalent. Drift here = secrets leak through new path.

Test file: `tests/hooks/scrub-parity.test.ts`. Loads fixtures from `tests/hooks/fixtures/scrub/`.

### 5.4 Hook end-to-end (CI)

- Each migrated hook script invoked with fixture stdin in a sandboxed temp `APPDATA` / `HOME`
- Assert exit code 0 (fire-and-forget) regardless of mock provider success/failure
- Assert no raw bearer appears in ingest log

### 5.5 Concurrency invariant

`_ingest-transcript.sh:166` uses `mktemp` to avoid clobbering between concurrent SubagentStop + SessionEnd fires. New path spawns one Bun process per hook → invariant holds for free. Add comment to shim noting the invariant; no test required.

## 6. Rollout

1. Implement §4.0 prerequisite — **DONE** in `609ba1f`
2. Implement §4.1.1 `ingest-transcript` subcommand + `TranscriptIngestPayloadSchema`
3. Capture fixture corpus (§5.2) + golden bodies
4. Implement scrub parity tests (§5.3); reconcile any regex divergence
5. Rewrite three hook scripts as thin shims with `MEMORY_LEGACY_HOOKS=1` rollback gate
6. Implement §4.2 env-var consolidation + `MEMORY_DEPRECATION_OPT_OUT=1`
7. Update `astramem doctor` to report legacy env-var hits + legacy hook invocation count
8. CHANGELOG entry: hooks now route through provider selector; Bun required (no change vs Wave 3 cmds); SaaS hook ingest uses static bearer (OIDC refresh in v0.7.0); legacy fallback gate documented
9. Marketplace bump per saved rule (`astra-marketplace` companion commit)
10. README troubleshooting section update (rollback gate + SaaS bearer caveat)

## 6.5 Rollback

`MEMORY_LEGACY_HOOKS=1` env var keeps old shell-script path live for one release. Each new shim checks the flag first and `exec`s the legacy script when set.

- CHANGELOG + README troubleshooting document the rollback
- `astramem doctor` detects `MEMORY_LEGACY_HOOKS=1` + emits one-line notice with link to issue tracker
- Legacy script removal scheduled NLT v0.8.0 (subject to telemetry — see §4.2)

## 7. Risks

- **Hook payload shape drift** — mitigated by §5.2 fixture corpus + golden-body assertion. **Blocking gate.**
- **Scrub regex divergence (POSIX vs JS)** — mitigated by §5.3 parity test. **Blocking gate.**
- **SaaS hook regression (no OIDC refresh)** — mitigated by static-bearer fallback + explicit v0.7.0 follow-up + CHANGELOG callout. Users on SaaS who relied on auto-refresh from hooks must set `MEMORY_BEARER` until v0.7.0 ships.
- **Bun availability on hook execution path** — slash commands already require Bun; consistent extension.
- **Legacy env-var users** — soft-deprecation only in v0.6.0; removal NLT v0.8.0 contingent on `astramem doctor` deprecation-hit telemetry showing low usage.

## 8. Open questions (resolved by architect)

1. ~~Endorse Option A (MCP stdio shim) or push for Option B / hybrid?~~ → Moved to FEAT 4b. Architect added Option C (direct HTTP MCP to daemon at `127.0.0.1:7777/mcp`) as default candidate.
2. ~~Keep `_load-env.sh` + `_ingest-transcript.sh` as opt-in legacy fallback or delete in v0.6.0?~~ → **Keep behind `MEMORY_LEGACY_HOOKS=1`**; delete NLT v0.8.0.
3. ~~`bin/astramem mcp` proxy or native?~~ → FEAT 4b.
4. ~~Env-var deprecation window — one release sufficient?~~ → **No.** Hold through ≥v0.8.0, surface deprecation-hit counts in `astramem doctor`, add `MEMORY_DEPRECATION_OPT_OUT=1` escape hatch.
5. ~~Collapse selector + secrets + scrub + log into `MemoryClient` facade?~~ → **Defer.** Premature; only two callers; build facade only when third caller proves repeated boilerplate. Revisit post-Wave-4.

## 9. Architect-flagged drive-bys (do alongside)

- `bin/astramem:91` version string says `0.4.0`; repo at `v0.5.0`. Bump to match. One-line fix, not blocking.
