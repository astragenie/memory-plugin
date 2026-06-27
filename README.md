# @astragenie/astramem-plugin

Claude Code plugin bridging the `astramem` CLI, provider selector, and auto-capture hooks to
AstraMemory — local or cloud.

---

## Quick start

```bash
# 1. Install Bun (https://bun.sh) if not already present
curl -fsSL https://bun.sh/install | bash

# 2. Install dependencies
bun install

# 3. Link the bin so `astramem` is on your PATH
bun link

# 4. Pair this workstation to a provider
astramem connect          # local daemon (astramem-local must be running)
# OR — if you have a dashboard claim code:
astramem connect ABCD-1234 --env prod
```

After pairing, Claude Code hooks and slash commands (`/recall`, `/remember`) resolve the provider
automatically. No manual env-var export required for day-to-day use.

---

## Slash commands

| Command | What it does |
| --- | --- |
| `/recall <query>` | Searches astramem and injects the top 5 hits into context. |
| `/remember <text>` | Stores the text as a typed memory (`fact`, `decision`, `note`, etc.). |

Both commands invoke `bin/astramem` internally via `bun ${CLAUDE_PLUGIN_ROOT}/bin/astramem`.
If the provider is unreachable they suggest `astramem health` for diagnosis.

---

## `astramem` CLI — sub-commands

| Sub-command | Description |
| --- | --- |
| `ingest` | Fire-and-forget: ingest a JSON payload. Exit 0 always (errors go to log). |
| `recall` | Recall memories matching a query. Prints `{ hits: [...] }` JSON to stdout. |
| `remember` | Store a new typed memory item. |
| `health` | Probe configured provider(s). JSON output `{ ok, provider, url, latencyMs }`. |
| `config` | Read/write config file via dot-path keys (`config get`, `config set`, `config unset`). |
| `doctor` | Print env vars, last 5 log lines, selector resolution, config validation. |
| `connect` | Pair this workstation to a provider (local daemon or SaaS dashboard code). |

Full flag reference: `astramem --help` or `astramem <subcommand> --help`.

---

## Provider selector

The selector resolves which provider handles each call. Resolution order (highest precedence first):

1. `--provider local|saas|auto` flag on the CLI invocation.
2. `ASTRAMEM_PROVIDER` environment variable.
3. `provider` field in `~/.config/astramem/config.json` (or `%APPDATA%\Astramem\config.json`).
4. `auto` default: probe local (`http://127.0.0.1:7777/health`) with a 5-second cached result;
   fall back to SaaS if local is not reachable.

The selector source is reported in `astramem doctor` output and in structured log lines emitted
at each dispatch.

---

## Unified config directory

All plugin state (config, ingest log, secrets) lives in one location:

| Platform | Path |
| --- | --- |
| POSIX (Linux / macOS) | `~/.config/astramem/` |
| Windows | `%APPDATA%\Astramem\` |

Key files:

| File | Purpose |
| --- | --- |
| `config.json` | Provider preference, SaaS URL, local URL, logging options. |
| `secrets.env` | Bearer token written by `astramem connect` (never committed). |
| `ingest.log` | Append-only log of every ingest attempt (scrubbed). |
| `ingest.log.1` | Previous rotation (overwritten on the next rotation event). |

Legacy `~/.astramemory/` paths (written by pre-v0.4.0 `memory-connect`) are read as a migration
fallback and left untouched.

---

## Bearer scrubbing

Every value written to stdout, stderr, `ingest.log`, or any structured log line is passed through
two scrub passes before write:

1. **Regex scrub** — `/Bearer\s+[A-Fa-f0-9]{32,128}/g` replaces matching substrings with
   `Bearer [REDACTED]`.
2. **Key scrub** — recursively walks any JSON object and replaces the value of any key matching
   `/api[_-]?key|token|bearer|secret|password/i` with `"[REDACTED]"`.

The scrub is applied in `src/lib/scrub.ts` and called at every provider error path and log sink.

---

## Fail-silent ingest log

`astramem ingest` (and the PreCompact / SessionEnd / SubagentStop hooks) write structured
one-line JSON entries to `ingest.log` on every attempt — success or failure. Errors from a
down provider are recorded here rather than surfaced to the calling process. The log is
append-only and human-readable; inspect it with `astramem doctor` or `tail` it directly.

---

## Log rotation

On each write to `ingest.log`, the logger checks the current file size. If the file exceeds
**10 MB**, it renames `ingest.log` → `ingest.log.1` (overwriting any prior `.1`) and starts
a fresh `ingest.log`. Only one backup is kept. All content in the backup has already been
scrubbed prior to write.

---

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASTRAMEM_PROVIDER` | (none) | Override provider selection (`local`, `saas`, `auto`). |
| `MEMORY_BEARER` | (resolved via `astramem connect`) | Bearer token for MCP transport (`.mcp.json`). |
| `MEMORY_API_URL` | `http://localhost:5201` | Legacy API base URL for hook scripts. |
| `MEMORY_MCP_URL` | `http://localhost:5202` | MCP server URL read by `.mcp.json`. |
| `MEMORY_INGEST_RETRIES` | `2` | POST attempt budget per hook fire. |
| `MEMORY_INGEST_RETRY_SLEEP` | `1` | Seconds between hook retry attempts. |
| `MEMORY_PRECOMPACT_MAX_TURNS` | `20` | Turns captured by PreCompact hook. |
| `MEMORY_SESSION_MAX_TURNS` | `40` | Turns captured by SessionEnd hook. |
| `MEMORY_SUBAGENT_MAX_TURNS` | `12` | Turns captured by SubagentStop hook. |
| `ASTRAMEMORY_ENV` | `prod` | Active profile name for `~/.astramemory/` legacy lookup. |
| `ASTRAMEMORY_HOOK_DEBUG` | `0` | Set `1` to emit one debug line per hook fire to stderr. |

---

## Hooks

| Hook | Trigger | Max turns | Override |
| --- | --- | --- | --- |
| PreCompact | Before context compaction | 20 | `MEMORY_PRECOMPACT_MAX_TURNS` |
| SessionEnd | Claude Code session exit | 40 | `MEMORY_SESSION_MAX_TURNS` |
| SubagentStop | Sub-agent task end | 12 | `MEMORY_SUBAGENT_MAX_TURNS` |

All hooks exit 0 and never block the triggering event. Failures (provider down, no Bearer,
`jq` missing) are written to `ingest.log` and silently swallowed.

---

## MCP server

`.mcp.json` registers an HTTP MCP server at `${MEMORY_MCP_URL}/mcp`. The slash commands do
**not** go through MCP — they invoke `bin/astramem` directly. The MCP server remains available
for other agents or tools that prefer the MCP protocol.

Export `MEMORY_BEARER` and `MEMORY_MCP_URL` before launching Claude Code if you want the MCP
transport live alongside the CLI path.

---

## Daily ops cheatsheet

```bash
# Ingest a JSON payload
astramem ingest --json '{"id":"s1","type":"transcript","text":"..."}'

# Recall recent decisions
astramem recall --query "provider selector decision" --k 10

# Store a note
astramem remember --content "We chose Bun over Node for the plugin runtime" --type decision

# Check provider health
astramem health

# Diagnose config + env
astramem doctor

# Get / set config values
astramem config get
astramem config get provider
astramem config set provider local

# Pair workstation (local daemon)
astramem connect

# Pair workstation (dashboard claim code)
astramem connect ABCD-1234 --env prod
```

---

## Companion projects

- [astramem-local](https://github.com/astragenie/astramemory-local) — local daemon that the
  `local` provider talks to. Run it on `localhost:7777` for offline / private memory.
- [runner-plugin](https://github.com/astragenie/runner-plugin) — Engineering OS runner plugin;
  shares the `astramem ingest` path for session digests.
- [crew / GEPA loop](https://github.com/astragenie/crew) — dev-team crew plugin whose
  PreCompact hooks feed into AstraMemory via this plugin.

---

## Back-compat bins

The following legacy bin names still work (shims that delegate to their `astramem`-prefixed
equivalents):

- `memory-login` → `astramem-login`
- `memory-refresh` → `astramem-refresh`
- `memory-token` → `astramem-token`
- `memory-connect` → `astramem-connect`

---

## Upgrading from memory-plugin (pre-v0.4.0)

See `CHANGELOG.md` v0.4.0 entry for the full list of breaking changes. Quick checklist:

1. Rename slash commands: `/memory:recall` → `/recall`, `/memory:remember` → `/remember`
   (or install as `@astragenie/astramem-plugin` — commands are unnamespaced by default).
2. Run `astramem connect` once to write the unified config dir.
3. Remove `ASTRAMEMORY_API_URL` and `ASTRAMEMORY_API_KEY` raw env vars from your shell rc
   (deprecated; removed at v1.7).
4. Restart Claude Code.
