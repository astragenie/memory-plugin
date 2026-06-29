# FEAT 4b: MCP Migration to Provider Plane (v0.6.1+)

**Date:** 2026-06-29
**Status:** Design open — architect added Option C; needs decision
**Predecessor:** FEAT 4a (hooks migration) at v0.6.0
**Target version:** v0.6.1 or v0.7.0 (after 4a stabilizes)

---

## 1. Problem

`.mcp.json` currently:

```json
{
  "mcpServers": {
    "astramem": {
      "type": "http",
      "url": "${MEMORY_API_URL}/mcp",
      "headers": { "Authorization": "Bearer ${MEMORY_BEARER}" }
    }
  }
}
```

Raw env-var interpolation. No auto-resolution against `secrets.env`. No connection to provider selector. Fresh install + running `astramem-local` daemon → MCP server unreachable until user manually exports `MEMORY_API_URL` + `MEMORY_BEARER`.

## 2. Goal

MCP server resolves daemon URL + bearer automatically when daemon is running. Single resolution plane shared with hooks (FEAT 4a) and slash commands (Wave 3).

## 3. Pre-decision required

### Option A — `bin/astramem mcp` stdio shim
`.mcp.json` → `type: "stdio"`, runs `bun bin/astramem mcp`. Bun resolves provider via selector at startup. Implements MCP tool surface natively in TS via `LocalProvider` direct calls (architect Q3 — native > proxy).

**Pros:** Single resolution plane. Auto-failover to SaaS possible. Bearer refresh + scrubbing.
**Cons:** New Bun subprocess per Claude Code session (~150ms cold start, NEEDS MEASUREMENT). New `mcp` subcommand to implement + maintain. MCP protocol-level correctness burden.

### Option B — SessionStart hook seeds env vars
Hook reads `secrets.env` + probes daemon `/health` + injects `MEMORY_BEARER` into Claude Code's MCP env.

**Pros:** No new long-lived process.
**Cons:** Fragile if cwd differs. Race between hook completion and MCP server start undefined. Portability of env injection across MCP client implementations unknown.

### Option C — Direct HTTP to daemon (architect's recommendation as default)
```json
{
  "mcpServers": {
    "astramem": {
      "type": "http",
      "url": "http://127.0.0.1:7777/mcp",
      "headers": { "Authorization": "Bearer ${MEMORY_BEARER}" }
    }
  }
}
```

Hardcoded canonical local URL. Single env var (`MEMORY_BEARER`), sourced from `secrets.env` via shell wrapper or SessionStart env injection.

**Pros:** No new subprocess. No proxy hop. No new `mcp` subcommand. Daemon already speaks MCP at `/mcp` (assumes daemon exposes it — **VERIFY**).
**Cons:** No SaaS-via-MCP auto-fallback. URL hardcoded to local default.

## 4. Decision criteria

Pick based on use-case dominance:

- **MCP against local daemon is dominant case** → Option C (simplest, fastest)
- **MCP against SaaS is first-class flow needing auto-fallback** → Option A
- **Neither A nor B clearly wins for hybrid users** → measure Option A startup cost first; fall back to C if >300ms cold

## 5. Prerequisites for design close

1. **VERIFY daemon `/mcp` endpoint exists** in `astramem-local` today. If absent, Option C is dead and choice collapses to Option A native.
2. **Measure Option A startup latency** — Bun cold start + selector probe + MCP `initialize`. If >300ms per session launch, C wins on cost.
3. **Quantify SaaS-MCP demand** — if no user uses MCP against SaaS today, Option C's missing-fallback is a non-issue.

## 6. Test plan (Option A — if chosen)

- `tests/e2e/mcp-stdio.test.ts` — spawn `bin/astramem mcp`, send MCP `initialize` over stdio, assert handshake + tool list returned, forward `tools/call` to mock LocalProvider, assert response shape
- Crash recovery — kill subprocess mid-session, assert Claude Code reconnect behavior documented
- Observability — startup log line (selector decision, URL, bearer present yes/no) appended to `mcp.log` sibling of ingest log
- `astramem doctor` — probe MCP shim health + report resolved provider

## 7. Test plan (Option C — if chosen)

- `tests/e2e/mcp-http.test.ts` — start mock daemon at `127.0.0.1:7777/mcp`, point Claude Code at `.mcp.json`, assert handshake + tool list
- SessionStart hook — assert `MEMORY_BEARER` populated from `secrets.env` before MCP server starts
- `astramem doctor` — probe daemon `/mcp` health

## 8. Open questions

1. Does the daemon expose `/mcp` today? (Blocks Option C.)
2. Measured cold-start of `bin/astramem mcp` shim? (Blocks Option A defensibility.)
3. Install-base telemetry on SaaS-via-MCP usage? (Blocks decision criteria §4.)
4. If Option A: MCP tool surface — mirror existing slash commands (recall, remember) + add health? Or richer surface (memory.search, memory.upsert, memory.delete)?

## 9. Non-goals

- Any work on hooks — owned by FEAT 4a
- Backend daemon changes (validate `/mcp` exists; do not extend in this FEAT)
- MCP authentication beyond bearer (OAuth, mTLS, etc.)
