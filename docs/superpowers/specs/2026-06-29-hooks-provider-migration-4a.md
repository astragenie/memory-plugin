# FEAT 4a: Hooks + Wire-Contract Unification (v0.6.0)

**Date:** 2026-06-29
**Status:** Architect-reviewed; Path 3a-saas (SaaS canonical authority) endorsed; awaiting build
**Predecessor:** v0.5.0 (Wave 3 — slash-cmd migration to Bun CLI + provider selector)
**Successor:** FEAT 4b — MCP Migration (separate file, v0.6.1+)
**Target version:** v0.6.0
**Architect verdict:** Two reviews (crew:architect + 3rdparty:architect-reviewer) both endorsed Path 3a-saas direction. See session summary at end.

---

## 1. Problem

**Three-repo discovery:** Wave 3 (v0.4.0 → v0.5.0) migrated `/astramem:recall` and `/astramem:remember` slash commands to `bin/astramem` Bun CLI (routes through `src/lib/selector.ts` → `LocalProvider | SaasProvider`). Auto-capture hooks remained on legacy shell-script plane. During this work, discovered:

1. **SaaS canonical authority** — `C:\work\mega\memory` (.NET 10 AstraMemory.Api at `https://api.astramemory.com`) implements `/ingest/transcript` with complete envelope: `{event, session_id, turns[], scrub metadata, wire_version}`, server-side scrub + divergence return, idempotency, 200-turn cap, 8KB/turn UTF-8 truncation, extraction job queue. Canonical.

2. **Daemon outlier** — `C:\work\mega\astramemory-local` diverged with primitive flat shape: `{session_id, source, content}`. Schema incompatible with SaaS. Daemon v0.1.x was built against incomplete SaaS OpenAPI (see #5 below).

3. **Plugin SaaS provider broken** — `src/providers/saas.ts` has URL bugs (recall → `/recall` should be `/memories/search`; remember → `/remember` should be `/memories` POST) and missing `ingestTranscript()` method. Hooks cannot use SaaS because method doesn't exist.

4. **Plugin schema aligned (v0.5.0+)** — `src/contracts/wire.ts` TranscriptIngestPayloadSchema designed against SaaS shape (mostly correct). Slice 3.5 added three fields: `client_scrub_version`, `client_scrub_hits_by_label`, `wire_version`. SaaS DTO needs these three fields added as nullable.

5. **OpenAPI gap root cause** — `C:\work\mega\memory\docs\api\openapi.yaml` is incomplete: missing `/ingest/transcript` and `/version` paths. Why daemon was built wrong: no published contract to validate against.

### 1.1 Three-repo Path 3a-saas convergence

- **SaaS** stays canonical (already correct; add DTO nullable fields + OpenAPI docs)
- **Daemon** migrates to SaaS schema (turns[] stored as role:text for chunker compat; idempotency table; /version endpoint; extraction fields stubbed)
- **Plugin** fixes SaaS provider (URL corrections; add ingestTranscript method; drop legacy daemon code path)

## 2. Goal

Three interconnected goals (strict delivery order):

1. **SaaS canonical DTO + OpenAPI** — add 3 nullable fields (`client_scrub_version`, `client_scrub_hits_by_label`, `wire_version`) to `IngestTranscriptRequest`; publish `/ingest/transcript` + `/version` to OpenAPI; add CI gate that fails build when any controller route is undocumented.

2. **Daemon schema unification** — migrate `/ingest/transcript` handler from flat `{source, content}` to SaaS-canonical envelope; dual-read legacy rows; add idempotency table + `/version` endpoint; stub extraction fields for caller compat.

3. **Plugin wire-contract convergence** — hooks call `bin/astramem ingest-transcript` → cli selector + secrets → SaaS-canonical envelope → both LocalProvider + SaasProvider accept same shape. Fix SaaS provider URL bugs + add missing `ingestTranscript()` method. Drop daemon-only code paths.

Result: fresh install with daemon at `:7777` → hooks auto-route via selector with zero env-var setup. Plugin SaaS provider proven E2E against real SaaS shape.

## 3. Non-goals (v0.6.0)

- MCP server changes — see FEAT 4b
- New backend distillation features beyond idempotency
- Schema changes to recall/remember/health endpoints (only `/ingest/transcript` + `/version` scope)
- Removal of legacy `ASTRAMEMORY_*` env vars (kept through ≥v0.8.0, ideally v1.0.0)
- (Legacy `_load-env.sh` + `_ingest-transcript.sh` were deleted in Slice 4 — never worked E2E against real Claude Code transcript shape, so no install base to preserve)
- SaaS bearer-refresh path inside hook ingest (deferred to v0.7.0)
- Vendored secret-pattern library swap (deferred v0.7.0)

## 4. Design (already-shipped + remaining)

### 4.0 Prerequisite (DONE — commit 609ba1f)

P0 bug from architect review:
- `src/providers/local.ts` previously imported `readLocalBearer` from root `lib/secrets.ts` stub (env-var only, async) instead of `src/lib/secrets.ts` (file-aware, sync).
- **Fixed** in commit `609ba1f` (2026-06-29): import swap, root stub deleted, hermetic datadir mock added to provider test.
- LocalProvider now genuinely reads `<unifiedConfigDir>/secrets.env`. Hook migration premise (the CLI does selector + secrets + scrub + log) is now operational.

### 4.1 Hooks migration (DONE — Slices 1–5 shipped)

**Completed slices:**

- **Slice 1** — `bin/astramem ingest-transcript` subcommand + `TranscriptIngestPayloadSchema` (commits `08899a1`, `3ffd54f`)
- **Slice 2** — Hook payload fixture corpus + golden-body replay gate (`c2bc304`)
- **Slice 3** — Bash↔JS scrub-parity test exposing 57 divergences (`74d5a16`) — informed Slice 3.5 scope
- **Slice 3.5** — Canonical scrubber v2 with 12 patterns (JWT, AWS key, Anthropic, OpenAI, GitHub PAT, Slack, Stripe, Google API, PEM, generic `keyword=value`, etc.); `scrubWithLabels()` API; `BEARER_RE` broadened to base64url; `client_scrub_version` + `client_scrub_hits_by_label` envelope fields added; parity test + dead bash `--scrub-only` deleted (commits `8107cae`, `99e0492`, `3c590a5`, `b1cc9f8`)
- **Slice 4** — Real Claude Code transcript shape handled (`extractTurnsFromJsonl` reads nested `.message.role`); three hook bash shims rewritten as thin `jq` + `exec bun bin/astramem ingest-transcript`; legacy `_load-env.sh` + `_ingest-transcript.sh` DELETED entirely (no rollback gate — nothing to roll back to; legacy bash hook never worked end-to-end against real transcripts); SubagentStop prefers `.agent_transcript_path` over `.transcript_path` (commits `f1f23b4`, `ae92cd3`, `0bbf1b8`, `453eceb`)
- **Slice 5** — Env-var consolidation via `resolveEnv()` + `ENV` registry; 10 canonical specs with legacy aliases; `aliasPredicate` for URL disambiguation; one-shot stderr deprecation warning per alias per process; `MEMORY_DEPRECATION_OPT_OUT=1` opt-out; per-alias hit counts for future `astramem doctor` (`5635611`)

**Hook shape (three shims, one pattern):**

Each hook's bash wrapper:
1. Read hook stdin payload (from Claude Code harness)
2. Extract fields with `jq` (transcript_path, session_id, cwd, agent_type; SubagentStop prefers `.agent_transcript_path // .transcript_path`)
3. Conditionally include `--agent-type` only when non-empty (matches jq `//` operator semantics)
4. `exec bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" ingest-transcript` with extracted args

CLI handler in `src/cli/ingest-transcript.ts`:
- Reads transcript JSONL from disk (handles both nested `.message.role` and flat `.role` shapes; `tool_use` / `tool_result` / `thinking` blocks silently dropped)
- Filters `role∈{user,assistant}`
- Tails to `--max-turns` (default 20 for all three hooks per Slice 4 rename; `MEMORY_SESSION_MAX_TURNS=40` legacy alias resolves via env-spec chain)
- Applies `src/lib/scrub.ts` per turn via `scrubWithLabels()` — single source of truth
- Builds `TranscriptIngestPayloadSchema` envelope with `client_scrub_version` + `client_scrub_hits_by_label`
- POSTs to provider via selector (LocalProvider, SaasProvider, or auto-probe)
- Fire-and-forget: exit 0 always; errors logged to `ingest.log`

**Wire contract alignment:**

`TranscriptIngestPayloadSchema` (current, Slice 3.5):
```ts
event: enum['pre_compact', 'session_end', 'subagent_stop']
session_id: string
project_id: string
agent_type?: string
cwd?: string
captured_at: ISO-8601 string
turns: [{ role: 'user'|'assistant', text: string, ts?: ISO-8601 }]
client_scrub_applied: boolean  // deprecated in favor of client_scrub_hits_by_label
client_scrub_hits: number  // deprecated; use client_scrub_hits_by_label sum
client_version: string  // plugin version
client_scrub_version: string  // scrubber version constant (NEW — Slice 3.5)
client_scrub_hits_by_label?: { [label]: count }  // per-label hits (NEW — Slice 3.5)
```

Matches SaaS canonical at `C:\work\mega\memory\src\AstraMemory.Api\Models\IngestTranscriptRequest.cs` except three nullable fields below.

### 4.2 Wire-contract unification (PENDING — this FEAT's core work)

#### 4.2.1 SaaS DTO additions

File: `C:\work\mega\memory\src\AstraMemory.Api\Models\IngestTranscriptRequest.cs`

Add 3 fields (matching plugin Slice 3.5). **2 nullable, 1 REQUIRED:**

```csharp
[property: JsonPropertyName("client_scrub_version")]
string? ClientScrubVersion,

[property: JsonPropertyName("client_scrub_hits_by_label")]
Dictionary<string, int>? ClientScrubHitsByLabel,

[property: JsonPropertyName("wire_version")]
[Required, RegularExpression("^v\\d+\\.\\d+$")]
string WireVersion,
```

`wire_version` REQUIRED per reviewer P0: nullable defeats its own daemon-divergence-prevention purpose. SaaS endpoint is new — zero v0 clients to break. Cost to require = zero. Cost to relax later = one DB migration. Pattern `^v\d+\.\d+$` (e.g. `v1.0`).

`client_scrub_version` + `client_scrub_hits_by_label` stay nullable — old plugin builds in the wild won't send them; don't 400 them. Server-side divergence telemetry (`server_hits > client_hits`) needs the version field to correlate "which scrubber generation produced this number."

These fields enable:
- Wire-version dispatch (server refuses unknown versions deterministically)
- Server-side scrubber version validation (advisory v0.7.0, enforced v0.8.0)
- Telemetry: which client versions use which scrubbers
- Per-label re-scrub divergence alarms (defense-in-depth secret-redaction)

Naming stays flat (no nested `scrub.*`) — consistency with existing flat fields (`client_scrub_applied`, `client_scrub_hits`, `client_version`).

#### 4.2.2 SaaS OpenAPI publication

File: `C:\work\mega\memory\docs\api\openapi.yaml`

Currently incomplete (marked with TODO comment at header). Root cause of daemon v0.1.x divergence.

**Missing paths:**
- `POST /ingest/transcript` — canonical handler at `TranscriptIngestController.cs:36`
- `GET /version` — uniform version discovery at `HealthController.cs`

**Missing response schema:**
- `IngestTranscriptResponse` (200) — defined in handler, not documented

Implementation slice will:
1. Auto-generate from `Microsoft.AspNetCore.OpenApi` + `Swashbuckle` introspection (or manual schema if CI lacks DB access)
2. Add CI gate: controller route NOT in OpenAPI → build fails
3. Prevents future drift (architect-flagged risk)

#### 4.2.3 Daemon schema migration

File: `C:\work\mega\astramemory-local\src\server\routes\ingest.ts`

Current (v0.1.x outlier):
```ts
POST /ingest/transcript { session_id, source, content }
```

Migrate to SaaS-canonical:
```ts
POST /ingest/transcript {
  event: enum,
  session_id: string,
  turns: [{ role, text, ts? }],
  project_id?: string,
  agent_type?: string,
  cwd?: string,
  captured_at: ISO-8601,
  client_scrub_applied: boolean,
  client_scrub_hits: number,
  client_version: string,
  client_scrub_version: string,  // NEW
  client_scrub_hits_by_label?: object,  // NEW
  wire_version?: string  // NEW
}
```

**Backward compat:**
- Existing v0.1.x rows (flat `source`/`content` shape) stay in DB
- Distill pipeline dual-reads: try new schema first, fall back to legacy shape if parsing fails
- No backfill (impossible; flat shape data is already distilled)

**New daemon features (v0.2.0):**

1. **Idempotency table** — `ingest_idempotency(idempotency_key: string PRIMARY KEY, request_hash: sha256, transcript_id: uuid, created_at: timestamp)`
   - Honors `Idempotency-Key` header on POST
   - Idempotency key derived from `(session_id, event, captured_at)` by plugin (UUIDv7)
   - Same request re-sent → returns 200 + original transcript_id (not duplicate)

2. **New transcripts table columns** (all nullable, migrate existing rows to NULL):
   - `event: string` (e.g. 'pre_compact', NULL for v0.1.x rows)
   - `captured_at: timestamp` (NULL for v0.1.x rows)
   - `client_scrub_version: string` (NULL for v0.1.x rows)
   - `client_scrub_hits_json: text` (stores stringified `{label: count}`, NULL for v0.1.x rows)

3. **Turns storage** — `turns[]` serialized as `role: text` newline-joined into existing `content` column
   ```
   user: How do I build a tree in Rust?
   assistant: Use the tree crate or write a recursive struct…
   user: Show me an example.
   assistant: Here's…
   ```
   Chunker already handles newline-separated lines; no pipeline change needed.

4. **Extraction fields stubbed** (for caller compat; actual distillation unchanged):
   - `extraction_job_id: null` (future: queue ID when distiller spawns extraction jobs)
   - `extracted_count: number` (from distill result; returned as `extracted_count`)
   - `failed_atom_count: 0` (stub; future: if extraction job fails, report atom count)
   - `queued_extraction_types: []` (stub; future: array of extraction job types queued)

5. **GET /version endpoint** — new, matches SaaS shape:
   ```json
   {
     "version": "0.2.0",
     "gitSha": "<commit>",
     "builtAt": "2026-06-30T00:00:00Z",
     "service": "astramemory-local"
   }
   ```
   Enables uniform discovery by plugin selector.

#### 4.2.4 Plugin SaaS provider fixes

File: `C:\work\mega\astramemory-plugin\src\providers\saas.ts`

**URL bugs (lines to fix):**
- Line 124 (recall): `POST /recall` → `POST /memories/search`
- Line 153 (remember): `POST /remember` → `POST /memories`

**Missing method:**
- Add `ingestTranscript(payload: TranscriptIngestPayload): Promise<{ transcriptId: string }>`
  - Mirrors LocalProvider method signature
  - Calls `POST /ingest/transcript` (SaaS canonical handler)
  - Uses `Idempotency-Key` header (derived from payload session_id + event + captured_at)

**Drop daemon-only code paths:**
- Review `src/lib/selector.ts` for any daemon-version-specific workarounds
- If found, remove once daemon v0.2.0 ships

### 4.3 Successor FEATs (split for scope discipline)

User review (2026-06-30) adopted full reviewer recommendations. Scope expansion split into successor FEATs to keep this one shippable:

- **FEAT 4c — Agentic API extension** (`docs/superpowers/specs/2026-06-30-agentic-api-extension-4c.md`): 3 new SaaS endpoints (`POST /memories/hydrate`, `POST /memories/decision`, `PUT/GET /memories/continuation`); 4 new plugin provider methods (`hydrate`, `recent`, `related`, `narrative`); 3 new slash commands (`/astramem:hydrate`, `/astramem:decide`, `/astramem:continue`). Target v0.7.0.
- **FEAT 4d — Route audience split** (`docs/superpowers/specs/2026-06-30-route-audience-split-4d.md`): split `MemoriesController` into `/agent/v1/*` (agent-facing) vs `/admin/v1/*` (UI/human-curation). Pre-empts 2-year auth/quota/rate-limit conflation. Target v0.8.0 or earlier per lead.

This FEAT (4a) ships minimum: hooks done, wire-contract unified, plugin SaaS provider URL bugs fixed. No new agentic methods. No new SaaS endpoints.

### 4.4 Delivery order (strict)

1. SaaS DTO + OpenAPI + CI gate merge to `main`
2. Daemon migration + dual-read merge to `main`
3. Plugin fixes merge to `main`
4. v0.6.0 plugin release (unblocked once steps 1–3 land)
5. Marketplace bump per saved rule (same session as plugin tag)

## 5. Test plan

### 5.1 Plugin tests (existing Slices 1–5, no new blocker added)

Already shipped:
- `tests/contracts/transcript-wire.test.ts` — `TranscriptIngestPayloadSchema` round-trip + reject malformed
- `tests/cli/ingest-transcript.test.ts` — CLI: arg parsing, file read, role filter, tail, scrub call count, envelope construction, exit 0 on provider failure
- `tests/lib/config-aliases.test.ts` — legacy env-var aliases resolve to canonical + one-time stderr warning + `MEMORY_DEPRECATION_OPT_OUT=1` suppresses
- `tests/hooks/scrub-parity.test.ts` — 100 known-secret strings through POSIX + JS scrubbers; assert identical output
- `tests/hooks/fixtures/*` — hook payload fixtures (5–10 representative) with golden wire bodies + golden jq extraction values

### 5.2 SaaS DTO additions test (implementation slice)

New test in `AstraMemory.Api.Tests`:
- `IngestTranscriptRequestTests.Deserialize_WithNullableFields_Succeeds()` — round-trip with 3 nullable fields present
- `IngestTranscriptRequestTests.Deserialize_WithoutNullableFields_Succeeds()` — backward-compat: old clients without fields still accepted
- `IngestTranscriptControllerTests.Post_WithValidIdempotencyKey_Returns200()` — honor idempotency-key header; same key + same body → same transcript_id

### 5.3 Daemon schema migration test (implementation slice)

New test in `astramemory-local`:
- `routes/ingest.test.ts: POST /ingest/transcript with SaaS-canonical envelope` — accept new shape, write DB, return 200
- `routes/ingest.test.ts: POST /ingest/transcript with legacy shape` — accept old flat shape (dual-read fallback), write DB
- `routes/version.test.ts: GET /version` — returns `{version, gitSha, builtAt, service}` with correct format
- `src/server/distill-worker.test.ts` — distiller reads both legacy + new shape correctly; `turns[]` serialized to newline-joined role:text in `content` column

### 5.4 Plugin SaaS provider end-to-end (implementation slice)

New test in `astramemory-plugin`:
- `tests/providers/saas.test.ts: recall()` — POSTs to `/memories/search` (not `/recall`)
- `tests/providers/saas.test.ts: remember()` — POSTs to `/memories` (not `/remember`)
- `tests/providers/saas.test.ts: ingestTranscript()` — new method exists, POSTs to `/ingest/transcript`, uses `Idempotency-Key` header
- `tests/providers/saas.e2e.test.ts` (optional) — if test credentials available, E2E against real SaaS at `https://api.dev.astramemory.com`; alternatively use recorded fixture

### 5.5 Cross-repo integration smoke (implementation slice)

Gate: one-command test that:
1. Starts local daemon in-process (astramemory-local test mode)
2. Posts SaaS-canonical envelope to daemon `/ingest/transcript`
3. Calls plugin `ingestTranscript()` against SaaS test endpoint (mocked or real)
4. Asserts both paths accept same envelope shape; no schema rejection

## 6. Rollout (strict merge order)

### Phase 1: SaaS DTO + OpenAPI (unblocks phases 2 + 3)

1. SaaS: Add 3 nullable fields to `IngestTranscriptRequest` (§4.2.1)
2. SaaS: Publish `/ingest/transcript` + `/version` to OpenAPI (§4.2.2)
3. SaaS: Add CI gate — any controller route missing from OpenAPI → build fails
4. SaaS: Add `IngestTranscriptResponseTests` (round-trip + nullable fields)
5. Tag: `memory@v<X>.0.0` (coordinated with implementation slice)

### Phase 2: Daemon schema migration (requires Phase 1 complete)

1. Daemon: Add 3 new transcripts columns (nullable, default NULL for backfill)
2. Daemon: Add idempotency table + migration file
3. Daemon: Migrate `/ingest/transcript` handler to SaaS-canonical schema
4. Daemon: Dual-read fallback for v0.1.x flat shape
5. Daemon: Add `GET /version` endpoint
6. Daemon: Stub extraction fields in ingest response
7. Daemon: Add distiller dual-read test for legacy + new shape
8. Daemon: Add dashboard migration notes (v0.1.x rows are read-only after upgrade until distilled)
9. Tag: `astramemory-local@v0.2.0` (coordinated with implementation slice)

### Phase 3: Plugin wire-contract convergence (requires Phase 1 complete; Phase 2 recommended before release)

1. Plugin: Fix SaaS provider URLs (recall + remember)
2. Plugin: Add `ingestTranscript()` method to SaaS provider
3. Plugin: Drop any daemon v0.1.x-specific code paths (review selector)
4. Plugin: Add `SaasProviderTests` for URL fixes + ingestTranscript
5. Plugin: Add cross-repo integration smoke test (daemon + SaaS both accept canonical shape)
6. Plugin: Update CHANGELOG (§4 goal reached; doc notes below)
7. Plugin: Update README endpoint matrix + troubleshooting (SaaS bearer static in v0.6.0; OIDC v0.7.0)
8. Plugin: `bin/astramem` version string `0.4.0` → match tag (Slice 6 drive-by)
9. Tag: `astramemory-plugin@v0.6.0` + marketplace bump (coordinated with tag)

### Phase 4: Slice 6 finalization (post-merge)

1. Plugin: `astramem doctor` enhancements: report legacy env-var hits, legacy hook invocation count
2. Plugin: `CHANGELOG.md` entry for v0.6.0
3. Plugin: Version bump in `package.json`
4. Marketplace rule: bump version every time plugin tags a release (tracked in user MEMORY.md)

### Rollback

No rollback gate. Legacy bash hook scripts (`_load-env.sh`, `_ingest-transcript.sh`, `--scrub-only` mode) were deleted in Slice 3.5 + Slice 4. Verification against `.claude/logs/payloads/` and user confirmation showed legacy path never shipped real content (bash `jq 'select(.role)'` reads top-level `.role` but real Claude Code transcript JSONL puts role at `.message.role`). Zero install base preserved. If wire-contract migration fails after v0.6.0 ships, rollback path is pinning plugin version in marketplace registry.

## 7. Risks & mitigation

| Risk | Impact | Mitigation | Gate |
|---|---|---|---|
| **Three-repo coordination first time** | Merge order violated → incompatible versions shipped | Strict phase order (§6); no parallelization until phase 1 lands | Phase merge order tracked in PR descriptions |
| **Existing daemon v0.1.x rows under legacy shape** | Dual-read fallback required indefinitely | Distiller dual-reads both shapes; no backfill policy (existing rows stay flat). Dashboard notes post-upgrade. | Distiller tests cover both paths |
| **wire_version enforcement policy undefined** | Version negotiation unspecified; clients unclear on minimum/advised versions | Advisory in v0.7.0 (server accepts all); enforced v0.8.0 (server rejects old versions). Documented in CHANGELOG. | CHANGELOG links policy doc |
| **Codegen vs hand-vendor OpenAPI** | OpenAPI drift risk if hand-authored; outdated if codegen tooling unavailable | Open question (§8). Recommend: generate from C# DTO via NSwag/Swashbuckle if CI has DB access; fallback to manual stub. | CI gate enforces completeness |
| **SaaS test credentials availability** | Plugin E2E may fail if no creds for test SaaS env | Acceptable: use recorded fixture (§5.4) instead. Recorded fixture stored in repo; real E2E runs on demand (marked optional). | Fixture path in test file |
| **SaaS static bearer regression for hook ingest** | Existing SaaS users using hook auto-refresh lose it in v0.6.0 | Documented in CHANGELOG + README troubleshooting. v0.7.0 FEAT planned (OIDC inside SaasProvider). Users must set `MEMORY_BEARER` until then. | CHANGELOG callout + link to v0.7.0 FEAT |

## 8. Open questions (architect input required)

1. **Codegen mechanism** — Generate OpenAPI from C# DTO via NSwag/Swashbuckle, or from `Microsoft.AspNetCore.OpenApi` introspection? Hand-authored stub is short-term fallback if CI cannot start API. **Recommend:** introspection path in CI, fallback to Swashbuckle CLI once workflows have DB access.

2. **`@astramem/wire-contracts` npm publication** — Published to npm public registry or GitHub Packages (matches memory monorepo convention)? **Open:** check memory monorepo's `npm:auth:check` script for pattern.

3. **Idempotency contract phrasing** — Should `Idempotency-Key` header be "MUST send" or "SHOULD send"? SaaS RFC 9110 language: "SHOULDs honor if present". **Recommend:** "clients SHOULD send for durability; server MUST honor if present" (asymmetric burden — caller wins). RFC reference in SPEC docs.

4. **daemon-dual-read sunset policy** — When (if ever) can we drop support for v0.1.x flat shape? Proposal: v0.4.0+ (12 months out). **Open:** track in follow-up ADR.

## 9. Architect-approved decisions

1. **Path 3a-saas:** SaaS canonical; daemon + plugin converge. Both reviews endorsed.
2. **Plugin ingestTranscript method:** Must exist for hooks to use SaaS. Matches LocalProvider signature.
3. **Idempotency-Key header required:** Plugin derives from `(session_id, event, captured_at)` using UUIDv7. Daemon stores request_hash for dedup.
4. **Extraction fields stubbed v0.2.0, populated later:** Extraction job queue is separate work (M9+). Daemon v0.2.0 returns `extraction_job_id: null`, `queued_extraction_types: []` for caller compat.

## 10. Estimated effort (NOT this slice; for future sprint planning)

- SaaS DTO + OpenAPI + CI gate: ~1.5 days
- Daemon schema migration + dual-read + extraction stubs: ~2.5 days
- Plugin URL fixes + ingestTranscript + cross-repo tests: ~1.5 days
- Integration testing + Marketplace bump: ~1 day
- **Total: ~6.5 days, 3 coordinated PRs across memory + astramemory-local + astramemory-plugin**

## 11. Drive-bys (do alongside implementation)

- Plugin `bin/astramem:91` version string `0.4.0` → match tag (handled in Slice 6 finalization)

## 12. Follow-ups / Backlog (from review)

Items surfaced during FEAT-4a Phase 3 code review (2026-06-30). None are blockers for v0.5.0 but should be tracked for future sprints.

### v0.4.1 Backport (regression from v0.4.0)

**Backlog item**: Cut a v0.4.1 patch release carrying only commit `06d20a8`'s `ingestTranscript()` addition for sites that cannot upgrade past v0.4.x.

Scope of backport: the single method addition from `06d20a8` only (no schema or constant changes, since the original v0.4.0 did not have `TranscriptIngestPayloadSchema` or `WIRE_VERSION`). The backport should add a minimal stub method that posts to `/ingest/transcript` and fire-and-forgets errors, matching the original v0.4.x SaaS provider shape.

See CHANGELOG `[0.5.0] Regression Disclosure` section for full impact statement.

### M1 — Mechanical version-sync gate with SaaS PR #530

Today the gate is purely social (CHANGELOG prose). Proposal: at plugin startup or ingest first-call, probe `/version` on the saas URL, confirm `wire_versions_supported` includes `'v1.0'`. If not, log a clear warning + disable saas branch. This prevents silent incompatibility when the SaaS server is upgraded to an incompatible wire version.

### M2 — CI Bun matrix floor pin

Current CI matrix uses `[latest]` only. Proposal: re-add `[1.1.30, latest]` matrix to detect Bun-breaking changes early; bisect on floor if a new Bun version breaks the suite.

### M3 — Selector auto-probe stampede on cold start

Concurrent ingest calls fire N parallel `/health` probes when the cache is cold. Fix: in-flight Promise dedup map — if a probe for a given URL is already in-flight, return the same Promise rather than issuing a new HTTP request.

### M4 — 5s probe timeout vs 2s CLI fire-and-forget budget on Windows

The health probe timeout is 5s; the CLI fire-and-forget budget is 2s. On Windows, if the probe times out, the auto-routing falls through to SaaS — effectively breaking local auto-routing for the 2s callers. Proposal: separate "fast probe" (300ms) for hot-path callers vs "deep probe" for `astramem doctor`.

### M5 — Doctor deprecation counters are per-process ephemeral

`astramem doctor` spawns a fresh process → hit counts are always 0. Proposal: append deprecation events to a sidecar `~/.config/astramem/deprecations.jsonl` for durability across process restarts. This makes `astramem doctor` useful for long-running operators.

### M6 — wire_version emission asymmetry

`saas.ts:ingestTranscript()` backfills `payload.wire_version ?? WIRE_VERSION`; `local.ts` does not have the same defensive backfill. Proposal: enforce at schema layer (`z.literal(WIRE_VERSION)`) OR centralize the backfill in a shared payload-builder utility function used by both providers.

### M7 — Slice 6 conflated contract bug-fix with finalize work

Commit `06d20a8` bundled the `ingestTranscript()` addition (a contract bug-fix) with finalize work. Future contract regressions should ship as standalone patches for cleaner cherry-pick and backport. This is a process recommendation, not a code change.

### M8 — Test-hook export hygiene

`_resetHealthCache`, `_setHealthProbeFn` (src/lib/selector.ts), `_resetEnvState` (src/lib/env.ts) are still exported from production modules. Current NODE_ENV guard silent no-ops them outside test — worse failure mode than throwing because it hides programming errors. Proposal for v0.6.0: move to `src/lib/_test-utils.ts`, omit from package `exports` map, fail loudly on misuse outside test. Today's guard accepted for v0.5.0 ship but tracked here.
