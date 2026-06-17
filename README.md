# memory plugin

Slash commands + auto-capture hooks bridging Claude Code to the AstraMemory
service. Wraps the existing MCP server with one-keystroke recall/store and
durable session capture across compaction.

## What's in it

### Slash commands

- `/recall <query>` — searches AstraMemory for memories matching the query and
  injects the top results into context. Uses the AstraMemory MCP `search_memory`
  tool. Honors inline filters like "in loop" / "for crew" → `project_id`,
  "handoffs" / "cost-reports" → `tags`.
- `/remember <text>` — stores the supplied text as a memory in AstraMemory with
  metadata inferred from context (project = repo name, tags = topical
  keywords, type = note / decision / fact based on phrasing).

### Hooks

- **PreCompact** — `hooks/scripts/pre-compact-capture.sh` runs right before
  Claude Code compacts the conversation. Tails the last 20 user+assistant
  turns from the live transcript, stores them as a `type=summary` memory
  with `source=claude-code-precompact` and `tags=[claude-code, pre-compact,
  session-digest]`. Substance survives the compaction window.
- **SessionEnd** — `hooks/scripts/session-end-summary.sh` runs on session
  close. Captures the last 40 turns as a `type=summary` memory with
  `source=claude-code-session-end` so the next session can recall what
  happened.

Both hooks are best-effort: if AstraMemory is unreachable, jq is missing, or the
transcript is gone, they silently `exit 0`. They never block compaction or
session shutdown.

### MCP server registration

`.mcp.json` declares the `memory` MCP server with `type: http`. The URL
and Authorization header are resolved from process environment variables
(`${MEMORY_MCP_URL}`, `${MEMORY_API_KEY}`) at Claude Code launch — see the
**Profiles** section below for how those get set.

## Profiles

The plugin ships two committed profiles. Pick one by setting
`MEMORY_ENV` in your shell before launching Claude Code.

| Profile    | When                                                 | API URL                                                                                              | MCP URL                                                                                              |
| ---------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `local`    | You run the AstraMemory stack on `localhost` (default). | `http://localhost:5201`                                                                              | `http://localhost:5202`                                                                              |
| `azuredev` | You hit the Azure-hosted gateway in centralus.       | `https://ca-yarp-dev.icymeadow-6c3aaa26.centralus.azurecontainerapps.io/memory-api`                  | `https://ca-yarp-dev.icymeadow-6c3aaa26.centralus.azurecontainerapps.io/memory-mcp`                  |

Both endpoints route through the YARP gateway, which runs in `JwtOrApiKey`
mode and enforces `AuthorizationPolicy=memory.read`. An ApiKey scoped to
`memory.read` is accepted on the same Authorization header the local
profile uses.

### How the hook scripts pick a profile

`hooks/scripts/_load-env.sh` is sourced first thing in every hook. It walks
the following resolution order, first match wins:

1. `$MEMORY_ENV` set in the shell → `${CLAUDE_PLUGIN_ROOT}/.env.$MEMORY_ENV`
2. `${CLAUDE_PLUGIN_ROOT}/.env` (gitignored user override)
3. `.defaultEnv` from `.claude-plugin/plugin.json` → `.env.<defaultEnv>`
4. `.env.local` (hard fallback)

### How `.mcp.json` picks a profile

Claude Code resolves `${...}` substitutions in `.mcp.json` from the OS
environment at plugin load. The plugin's `.env.*` files are not auto-sourced
into Claude Code's environment, so for the MCP transport you have two
options:

- **Export the values in your shell / system env before launching Claude**
  (or set them via your shell rc / Windows User Variables).
- **Use the gitignored `.env`** in combination with a shell loader you
  already run (e.g. `direnv`, `dotenv-cli`, `Set-PsEnv`).

The hook scripts don't need this — they source `.env.*` themselves.

### Releases

`defaultEnv` in `.claude-plugin/plugin.json` controls what the hooks fall
back to when no `MEMORY_ENV` and no `.env` override is present. The
release flow is:

- `main` branch keeps `defaultEnv: "local"` so contributors hit their
  local stack.
- Before tagging a release, flip `defaultEnv` to `"azuredev"` so installed
  copies of the plugin reach the hosted gateway without per-user config.

## Configuration

Environment variables (all optional, defaults come from the active
profile):

| Var                              | Default (local profile) | Purpose |
| -------------------------------- | ----------------------- | ------- |
| `MEMORY_ENV`                     | (none)                  | Selects the `.env.<profile>` file |
| `MEMORY_API_URL`                 | `http://localhost:5201` | API base used by hooks |
| `MEMORY_MCP_URL`                 | `http://localhost:5202` | MCP base used by `.mcp.json` |
| `MEMORY_API_KEY`                 | `dev-bootstrap-local`   | API key for `Authorization: ApiKey ...` |
| `MEMORY_PRECOMPACT_MAX_TURNS`    | `20`                    | Turns captured pre-compact |
| `MEMORY_PRECOMPACT_MAX_CHARS`    | `12000`                 | Hard byte cap on the digest |
| `MEMORY_SESSION_MAX_TURNS`       | `40`                    | Turns captured at session end |
| `MEMORY_SESSION_MAX_CHARS`       | `20000`                 | Hard byte cap on the digest |

## Requirements

- For the `local` profile: AstraMemory stack running
  (`dotnet run --project src/MemoryService.AppHost`).
- For the `azuredev` profile: a `MEMORY_API_KEY` scoped to `memory.read`
  on the gateway. Anonymous calls return 401.
- Hooks need `curl` and `jq` on the shell PATH. On Windows, run inside Git
  Bash or set `CLAUDE_BASH_PATH` to an MSYS bash. Without jq the hooks exit
  cleanly without recording anything. `jq` is also used to read
  `defaultEnv` from `plugin.json` — if it's missing the loader falls back
  straight to `.env.local`.

## Relationship to MCP

The MCP server (`src/MemoryService.Mcp`) is the data plane. This plugin is
a thin UX layer on top:

- Slash commands give you keyboard-fast access to MCP tools without the
  model having to decide whether to call them.
- Hooks give you deterministic durable capture independent of the model's
  search behavior.

Use both. They compose.

## Migrating from `cortex` plugin (pre-v0.2.0)

v0.2.0 renamed the plugin from `cortex` to `memory`. Breaking changes:

- Slash commands: `/cortex:remember` → `/memory:remember`, `/cortex:recall` → `/memory:recall`
- Env vars: `CORTEX_*` → `MEMORY_*` (rename every `CORTEX_API_URL`, `CORTEX_MCP_URL`, `CORTEX_API_KEY`, `CORTEX_CLERK_*`, `CORTEX_PRECOMPACT_*`, `CORTEX_SESSION_*` in your shell rc and any deployment env)
- CLI scripts: `cortex-login` → `memory-login`, `cortex-refresh` → `memory-refresh`, `cortex-token` → `memory-token`
- Auth cache path: `~/.config/cortex/auth.json` → `~/.config/memory/auth.json` (POSIX) and `%APPDATA%\cortex\auth.json` → `%APPDATA%\memory\auth.json` (Windows). Either move the file manually or re-run `memory-login`.
- MCP server name in `.mcp.json`: `cortex` → `memory` (only matters if another plugin or external tool references the MCP server by name).

Marketplace install command flips from `/plugin install cortex@astra` to `/plugin install memory@astra`.
