#!/usr/bin/env bash
# AstraMemory pre-compact capture hook.
#
# Forwards transcript turns to the AstraMemory server for scrub + extraction.
# Never blocks compaction: always exits 0.

set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ASTRAMEMORY_HOOK_SCRIPT_NAME="pre-compact-capture"
. "$SCRIPT_DIR/_load-env.sh"

MAX_TURNS="${MEMORY_PRECOMPACT_MAX_TURNS:-20}"
MAX_CHARS="${MEMORY_PRECOMPACT_MAX_CHARS:-12000}"

exec "$SCRIPT_DIR/_ingest-transcript.sh" \
  --event pre_compact \
  --max-turns "$MAX_TURNS" \
  --max-chars "$MAX_CHARS"
