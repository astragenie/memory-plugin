# astramem-plugin — Developer Reference

## Architecture overview

```
hooks/scripts/          Bash shims — thin JSON parsers, exec bin/astramem
src/cli/                TypeScript subcommand implementations
src/lib/                Shared library modules
src/contracts/          Zod schemas + TypeScript types
tests/                  Vitest unit tests
.claude-plugin/         Plugin manifest (plugin.json)
bin/astramem            Entry-point dispatcher
```

## Pending retry queue

**Purpose**: prevent silent transcript loss when the AstraMemory daemon is down or
restarting. Any hook invocation that fails with a transient error (ECONNREFUSED,
timeout, 5xx) writes the payload to a local pending directory instead of discarding it.

**Location**:
- Windows: `%APPDATA%\Astramem\pending\`
- Linux/macOS: `~/.config/astramem/pending/`

**When it drains**: at the top of every `astramem ingest-transcript` invocation
(i.e., every hook fire). The drain runs before the live call, processing up to 20
oldest files per invocation to keep hook latency bounded.

**Drain outcomes per file**:
- **200 OK** → file deleted, logged as `pending: drained <filename>`
- **Transient failure** → file left in place, retried next invocation
- **Deterministic failure (4xx / schema error)** → file moved to `pending/rejected/`, logged

**Cap**: if `pending/` reaches 100 files OR 100 MB, oldest files are deleted
with a warning in `ingest.log`. This prevents unbounded growth during extended
daemon outages.

**Rejected files**: stored in `pending/rejected/`. These payloads failed with a
non-retriable error (e.g. bad payload shape, authentication failure). They are
kept for forensic inspection but never re-retried automatically.

**Observability**: `astramem doctor` prints a PENDING section:
```
PENDING
  count: N files (M MB)
  oldest: 2026-07-01 00:19:23 (age: 4h)
  rejected: R files
```
And in `--json` mode:
```json
{
  "pending": {
    "count": 3,
    "bytes": 12288,
    "oldest_epoch_ms": 1751404800000,
    "rejected_count": 0
  }
}
```

**Source**: `src/lib/pending.ts` — `enqueue()`, `drain()`, `capEnforce()`, `stats()`

## Hook scripts

All hook scripts in `hooks/scripts/` follow the same pattern:

1. Read JSON payload from stdin via `jq`
2. Normalize `TRANSCRIPT_PATH` separators (`\\` → `/`)
3. Optionally emit debug info when `ASTRAMEM_HOOK_DEBUG=1`
4. `exec bun bin/astramem ingest-transcript ...`

**Debug mode**: set `ASTRAMEM_HOOK_DEBUG=1` in the environment before invoking
Claude Code. All three hook scripts will print to stderr:
- `session_id`, `transcript_path`, `cwd`
- Contents of the transcript file's parent directory

This surfaces path resolution failures without modifying normal fire-and-forget
behaviour.

## Path handling (issue #12)

Claude Code may hand a subagent transcript path with:
- Windows backslash separators preserved through JSON parsing
- A race where the JSONL file is not yet fully flushed when the hook fires

The fix operates at two levels:
1. **Bash shims**: `TRANSCRIPT_PATH="${TRANSCRIPT_PATH//\\//}"` normalises separators before the path reaches the CLI
2. **CLI** (`ingest-transcript.ts`): `path.resolve(transcriptPath)` canonicalises the path, then polls up to 3 times with 200ms + 300ms gaps before declaring the file not found

## Ingest log

Location: `%APPDATA%\Astramem\ingest.log` (Windows) or `~/.config/astramem/ingest.log`

Rotated at 10 MB → `ingest.log.1`. All entries are scrubbed.

## Running tests

```sh
bun test tests/cli/ingest-transcript.test.ts tests/lib/pending.test.ts
bun test                    # full suite (some vi.* API tests known-fail on bun 1.3)
bunx tsc --noEmit           # type check
```
