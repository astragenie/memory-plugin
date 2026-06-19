# Changelog

## 0.3.0 — 2026-06-19

### Breaking
- Drop `MEMORY_API_KEY` from `.env.local` and `.env.azuredev`. All ingest traffic uses Clerk Bearer via `memory-refresh`.
- `.mcp.json` Authorization header is now `Bearer ${MEMORY_BEARER}`. Operators must export `MEMORY_BEARER` from their shell rc (e.g. `export MEMORY_BEARER="$(memory-refresh)"`). Long sessions may need a Claude Code restart when the bearer TTL expires.

### Added
- POST `/ingest/transcript` server endpoint (server work tracked separately): scrub + summary + LLM extraction of `decision` / `fact` / `lesson` / `event` atoms + graph edges (`mentions`, `relates_to`, `supersedes`).
- `SubagentStop` hook captures Task-agent transcript tails.
- Client-side regex scrub (JWT / AWS / Anthropic / generic secret patterns) with hit count reported to server.
- Client-side retry (default 2) on 5xx / network errors. 4xx is final.

### Changed
- `pre-compact-capture.sh` and `session-end-summary.sh` now delegate to `_ingest-transcript.sh`. They no longer POST directly to `/memories`.
