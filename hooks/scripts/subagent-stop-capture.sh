#!/usr/bin/env bash
# AstraMemory subagent-stop capture hook.
#
# Forwards the last N turns of a Task-agent transcript to the server.
# Always exits 0 — never blocks the SubagentStop chain.

set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ASTRAMEMORY_HOOK_SCRIPT_NAME="subagent-stop-capture"
. "$SCRIPT_DIR/_load-env.sh"

MAX_TURNS="${MEMORY_SUBAGENT_MAX_TURNS:-12}"
MAX_CHARS="${MEMORY_SUBAGENT_MAX_CHARS:-8000}"

exec "$SCRIPT_DIR/_ingest-transcript.sh" \
  --event subagent_stop \
  --max-turns "$MAX_TURNS" \
  --max-chars "$MAX_CHARS"
