#!/usr/bin/env bash
# subagent-stop-capture.sh — FEAT 4a Slice 4
# Thin shim: extract fields from hook stdin via jq, exec bin/astramem ingest-transcript.
# SubagentStop prefers .agent_transcript_path; falls back to .transcript_path.
# Fire-and-forget: exits 0 even if jq/bun fails or transcript missing.
set +e
set -u

PAYLOAD="$(cat)"
if [ -z "$PAYLOAD" ]; then
  exit 0
fi

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // "unknown"')"
TRANSCRIPT_PATH="$(printf '%s' "$PAYLOAD" | jq -r '(.agent_transcript_path // .transcript_path) // empty')"
CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty')"
AGENT_TYPE="$(printf '%s' "$PAYLOAD" | jq -r '.agent_type // empty')"

# project_id = basename of cwd (matches existing project_id convention)
if [ -n "$CWD" ]; then
  PROJECT_ID="$(basename "$CWD")"
else
  PROJECT_ID="$(basename "$PWD")"
fi

ARGS=(
  ingest-transcript
  --event subagent_stop
  --session-id "$SESSION_ID"
  --project-id "$PROJECT_ID"
)
[ -n "$TRANSCRIPT_PATH" ] && ARGS+=(--transcript-path "$TRANSCRIPT_PATH")
[ -n "$CWD" ] && ARGS+=(--cwd "$CWD")
[ -n "$AGENT_TYPE" ] && ARGS+=(--agent-type "$AGENT_TYPE")
ARGS+=(--max-turns "${MEMORY_SUBAGENT_MAX_TURNS:-20}")
ARGS+=(--max-chars "${MEMORY_SUBAGENT_MAX_CHARS:-12000}")

exec bun "${CLAUDE_PLUGIN_ROOT}/bin/astramem" "${ARGS[@]}" >/dev/null 2>&1
