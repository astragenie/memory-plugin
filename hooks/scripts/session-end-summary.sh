#!/usr/bin/env bash
# AstraMemory session-end summary hook.
#
# Forwards last-N transcript turns to the server for scrub + extraction.

set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/_load-env.sh"

MAX_TURNS="${MEMORY_SESSION_MAX_TURNS:-40}"
MAX_CHARS="${MEMORY_SESSION_MAX_CHARS:-20000}"

exec "$SCRIPT_DIR/_ingest-transcript.sh" \
  --event session_end \
  --max-turns "$MAX_TURNS" \
  --max-chars "$MAX_CHARS"
