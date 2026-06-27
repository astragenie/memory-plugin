# astramem-plugin v0.4.0 — Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename memory-plugin → astramem-plugin AND migrate from `.mjs` to TypeScript + Bun AND ship the `astramem` CLI provider selector — all in one v0.4.0 cut. Combines memory-plugin#8 implementation with TS+Bun standardization.

**Architecture:** Bun-native ESM TypeScript. `#!/usr/bin/env bun` shebangs run `.ts` directly — no build step, no `dist/`. Vitest for tests. Bearer scrubbing at every output sink. Fail-silent ingest log under unified XDG-style config dir `~/.config/astramem/`.

**Spec:** memory-plugin#8 (locked comments)

---

## Wave map

```
Wave 1 (sequential, single owner) — Foundation
  └─ TS+Bun scaffold + rename + migrate existing .mjs → .ts + lock contracts + stub astramem CLI

Wave 2 (3 parallel tracks)
  ├─ Track A: providers (local + saas impls)
  ├─ Track B: selector + config + bearer scrub + ingest log + rotation
  └─ Track C: astramem CLI subcommands + tests

Wave 3 (sequential) — Integration
  └─ astramem-local-connect + commands/recall.md+remember.md rewrite + README + CHANGELOG + E2E

Wave 4 (sequential) — CI + polish
  └─ Bun cross-OS CI + smoke + v0.4.0 tag
```

**Critical path:** Wave 1 → Track A + Track B (selector depends on providers) → Track C → Wave 3 → Wave 4 ≈ 1 week sequential, ~3 days with parallel agents.

---

## Wave 1 — Foundation (single owner)

### Tasks

1. **Rename package + manifest**
   - `package.json`: `name: "@astragenie/astramem-plugin"`, version `0.4.0-rc.1`.
   - `.claude-plugin/plugin.json`: `name: "astramem"`, bump to 0.4.0, update description to mention provider selector.

2. **TS + Bun scaffold**
   - `tsconfig.json`: strict, ES2022, ESNext modules, no emit, allowImportingTsExtensions.
   - `.gitignore`: add `bun.lockb`, `node_modules/`, `.bun/`.
   - `package.json` scripts: `test: "vitest run"`, `test:watch: "vitest"`, remove `node --test`.
   - Add devDeps: `vitest`, `@types/node`, `typescript`. Keep `zod` as runtime dep.
   - Bin field rewrite (see step 4).
   - Install: `bun install`. Commit `bun.lockb`.

3. **Migrate existing .mjs → .ts (mechanical)**
   - `lib/clerkAuthFile.mjs` → `lib/clerkAuthFile.ts` (TS-typed).
   - Other `.mjs` helpers in `lib/` likewise.
   - `bin/memory-login` → `bin/memory-login.ts` with shebang `#!/usr/bin/env bun`.
   - Same for `memory-refresh`, `memory-token`, `memory-connect`.
   - Update package.json bin entries to point at `.ts` files.

4. **Lock contracts** in `src/contracts/`
   - `selector.ts`: `Provider = 'local' | 'saas'`, `SelectorResult`, `SelectorOpts`.
   - `provider.ts`: `MemoryProvider` interface (ingest, recall, remember, health).
   - `config.ts`: `AstramemConfig` Zod schema (provider, local, saas, logging blocks).
   - `wire.ts`: shared with astramem-local — `IngestPayloadSchema`, `RecallRequestSchema`, `RecallResponseSchema` (the unified shape per memory-plugin#8 decision 8-9).
   - `index.ts` re-export.

5. **Stub `astramem` CLI**
   - `bin/astramem` (no extension, shebang `#!/usr/bin/env bun`) — minimal dispatcher: parse subcommand, delegate to placeholder for each. Stubs print "not yet wired" + exit 0 except `--help`/`--version`.
   - Subcommands to declare in help: `ingest`, `recall`, `remember`, `health`, `config get|set`, `doctor`, `connect`.
   - `--provider local|saas|auto` flag parsed and passed to stub.

6. **Add bin aliases** (back-compat + forward-compat)
   - `bin/astramem-login`, `bin/astramem-refresh`, `bin/astramem-token`, `bin/astramem-connect` — each is a 1-line shim: `#!/usr/bin/env bun\nimport('./memory-X.ts');`
   - package.json bin field lists BOTH old and new names so users on either pattern work.

7. **Commit + tag `wave-1-foundation`**

### Acceptance

- `bun install` succeeds.
- `vitest run` passes (no new tests yet; existing `tests/*.test.mjs` may need rename to `.test.ts` or stay as-is — verify Bun executes `.mjs` test files).
- `bun bin/astramem --help` prints subcommand list.
- `bun bin/memory-login --help` (legacy) still works.
- `bun bin/astramem-login --help` (new alias) prints same output as legacy.
- TypeScript compiles with no errors via `tsc --noEmit`.

---

## Wave 2 — Parallel fan-out (3 tracks)

### Track A — Providers

**Files:**
- `src/providers/local.ts` — implements `MemoryProvider` against `http://127.0.0.1:7777`. Bearer from unified config dir's `secrets.env` (read via `lib/secrets.ts`). 2s ingest timeout, 5s recall timeout. Retry once on 5xx + network. POST `/ingest/transcript`, POST `/recall`, POST `/remember`, GET `/health`.
- `src/providers/saas.ts` — implements `MemoryProvider` against SaaS gateway URL. Reuses `lib/clerkAuthFile.ts` for Bearer. Same timeouts.
- `tests/providers/local.test.ts` — mock fetch via undici MockAgent, contract suite.
- `tests/providers/saas.test.ts` — same.

**Contract test suite (shared):**
- `tests/providers/_contract.ts` parameterized — every provider must satisfy: ingest fire-and-forget never blocks > 3s; recall returns unified-shape RecallResponse; health returns `{ok, version, url, latencyMs}`; 4xx → DeterministicError; 5xx → TransientError with retry.

### Track B — Selector + config + log + scrub

**Files:**
- `src/lib/config.ts` — read/write `~/.config/astramem/config.json` (or `%APPDATA%/Astramem/config.json`). Migration from legacy `~/.astramemory/`. Zod-validated.
- `src/lib/datadir.ts` — `unifiedConfigDir()` per OS.
- `src/lib/scrub.ts` — regex `/Bearer\s+[A-Fa-f0-9]{32,128}/g` + JSON-aware redact (recursively replace any value under keys matching `/api[_-]?key|token|bearer|secret|password/i`).
- `src/lib/log.ts` — append-only ingest log at `~/.config/astramem/ingest.log`. Rotates: on next write if file > 10MB → rename to `ingest.log.1` (overwrite), start fresh. Scrub before write.
- `src/lib/selector.ts` — resolution order: flag → env (`ASTRAMEM_PROVIDER`) → config → `auto` (probe local /health 5s cached in-process, fallback to saas). Returns `{provider: MemoryProvider, source: 'flag'|'env'|'config'|'auto'|'fallback'}`.
- `tests/lib/scrub.test.ts` — 64-hex token never appears in scrubbed output; api_key field redacted.
- `tests/lib/selector.test.ts` — precedence matrix: flag overrides env overrides config overrides default.
- `tests/lib/log.test.ts` — rotation at 10MB, append idempotency.
- `tests/lib/config.test.ts` — schema validation, dot-path get/set, migration from legacy path.

### Track C — astramem CLI subcommands

**Files:**
- `src/cli/ingest.ts` — `astramem ingest --json '<payload>'`. Validates JSON via `IngestPayloadSchema`. Posts via selector. Fire-and-forget 2s cap. Errors → ingest log + exit 0.
- `src/cli/recall.ts` — `astramem recall --query "q" [--k 5] [--repo r] [--project p]`. Posts via selector. 5s timeout. Prints normalized JSON array to stdout. Exit 3 on error.
- `src/cli/remember.ts` — `astramem remember --content "text" [--type decision|fact|lesson|command|todo]`. Posts via selector.
- `src/cli/health.ts` — `astramem health`. Probes via selector. JSON output: `{ok, provider, version, url, latencyMs}`. Exit 0 if ok, exit 3 if both providers down.
- `src/cli/doctor.ts` — selector resolution + last 5 log lines + env var presence + config validation.
- `src/cli/config.ts` — `astramem config get [key]`, `astramem config set <key> <value>`, `astramem config unset <key>`. Dot-path keys per memory-plugin#8 decision 4.
- `src/cli/connect.ts` — `astramem connect`. Reads bearer from astramem-local's secrets.env (`unifiedConfigDir()/secrets.env`). POSTs `/register` to local daemon. Caches result in `local.json`. (Daemon `/register` may not exist yet on v0.1.x; tolerate 404 and store best-effort.)
- `bin/astramem` — flesh out the dispatcher from Wave 1 to actually invoke each subcommand.
- `tests/cli/*.test.ts` — one per subcommand. Mock providers.

### Coordination rules

- Contracts in `src/contracts/` are frozen by Wave 1. Any change requires PR review.
- `src/lib/log.ts` is owned by Track B. Track C uses it via import, doesn't modify.
- `src/lib/selector.ts` is the bridge between A + B + C. Lands as part of Track B but A + C consume.

---

## Wave 3 — Integration

### Files modified
- `bin/astramem-local-connect.ts` — already added in Track C. Wave 3 enriches with helpful next-step text.
- `commands/recall.md` — rewrite frontmatter + body to invoke `bin/astramem recall` via the slash-command's bash hook.
- `commands/remember.md` — same.
- `README.md` — full rewrite: new name, astramem CLI usage, provider selector explanation, unified config dir, env vars, daily ops cheatsheet, links to astramem-local + crew + runner-plugin.
- `CHANGELOG.md` — v0.4.0 entry: rename, TS+Bun migration, astramem CLI, provider selector, bearer scrub, fail-silent log.
- `tests/e2e/plugin-flow.test.ts` — spin a fake local + fake saas, run `bun bin/astramem ingest`, assert routing + log + scrub.

### Acceptance
- `bun bin/astramem ingest --json '{"session_id":"x","source":"e2e","content":"hello"}'` exits 0, ingest log has redacted Bearer.
- `bun bin/astramem recall --query "x"` returns hits from local when up, saas when local down.
- `bun bin/astramem health` returns valid JSON for each provider.
- `commands/recall.md` slash command in Claude Code works end-to-end against local daemon.
- All Wave 1 + 2 tests still green.

---

## Wave 4 — Cross-OS CI + polish

### Files
- `.github/workflows/test.yml` — Ubuntu + macOS + Windows × Bun 1.1+ matrix.
- `.github/dependabot.yml` — npm + actions weekly groups.
- README badges updated.
- Tag `v0.4.0`.

### Acceptance
- Push triggers test workflow on 3 OS × 1+ Bun version.
- fail-fast: false.

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Bun not installed on user machine | README requires Bun; install instructions linked |
| Existing tests (`tests/*.test.mjs`) break under Bun + vitest | Convert mechanically to `.test.ts`; `node --test` API → vitest API |
| Bearer leaking via uncovered fetch error message | Test the global scrub by forcing 401 in providers; grep entire stdout/stderr/log file |
| Plugin discovery breaks if bin extension changes | Plugin manifest references files by relative path; Claude Code spawns via shebang — works with `.ts` if `bun` on PATH |
| Selector cache too aggressive | 5s in-process only; matches memory-plugin#8 decision 5 |
| Config dir migration corrupts existing data | Read legacy paths if present; copy not move (legacy untouched) |
| /register endpoint absent on astramem-local v0.1.1 | `astramem connect` tolerates 404, marks `register_pending`, retries on next `connect` |

---

## Done definition

- [ ] `bun install` + `vitest run` green.
- [ ] `bun bin/astramem` lists 7 subcommands.
- [ ] Ingest fire-and-forget proven under both providers + both fallback paths.
- [ ] Recall returns unified shape from both providers.
- [ ] Bearer scrub test: 64-hex token absent from stdout / stderr / log after forced 401.
- [ ] Cross-OS CI green.
- [ ] README updated.
- [ ] CHANGELOG entry.
- [ ] Tag `v0.4.0`.

---

## Execution

Wave 1 → single agent (sequential).
Wave 2 → 3 parallel agents.
Wave 3 → single agent.
Wave 4 → single agent.

Total wall: ~3 hours with agents + inline rescue (matches astramem-local pattern).
