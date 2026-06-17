#!/usr/bin/env bash
# AstraMemory session-end summary hook.
#
# Fires when a Claude Code session ends. Reads the hook payload from stdin,
# pulls the transcript, asks the assistant (via the AstraMemory /memories/report
# endpoint, which already wraps the LLM) to produce a 5-bullet session
# summary, and stores it as a memory of type=summary.
#
# Like pre-compact-capture, this never fails the hook chain. If anything is
# missing — AstraMemory offline, jq missing, transcript absent — we silently exit 0.

set +e
set -u

# Load profile (.env.local / .env.azuredev / .env / plugin.json defaultEnv).
# shellcheck source=./_load-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/_load-env.sh"

MEMORY_API_URL="${MEMORY_API_URL:-http://localhost:5201}"
MEMORY_API_KEY="${MEMORY_API_KEY:-dev-bootstrap-local}"
MAX_TURNS="${MEMORY_SESSION_MAX_TURNS:-40}"
MAX_CHARS="${MEMORY_SESSION_MAX_CHARS:-20000}"

payload="$(cat 2>/dev/null || true)"
[ -z "$payload" ] && exit 0

if ! curl -sS -o /dev/null -m 2 "${MEMORY_API_URL}/health"; then
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

transcript_path="$(printf '%s' "$payload" | jq -r '.transcript_path // empty')"
session_id="$(printf '%s' "$payload" | jq -r '.session_id // "unknown"')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"

[ -z "$transcript_path" ] && exit 0
[ ! -f "$transcript_path" ] && exit 0

project_id="$(basename "${cwd:-$PWD}")"

# Pull the last N turns as plain text. Store the raw digest — we keep this
# as the body of the memory so it's queryable. Future iteration can add a
# pre-summarization step via /memories/report.
digest="$(
  tail -n "$((MAX_TURNS * 4))" "$transcript_path" 2>/dev/null \
    | jq -r 'select(.role == "user" or .role == "assistant") | "[\(.role)] \(.content // .text // "")"' 2>/dev/null \
    | tail -n "$MAX_TURNS" \
    | head -c "$MAX_CHARS"
)"

[ -z "$digest" ] && exit 0

content="$(printf 'Session summary (%s)\n\nProject: %s\nSession: %s\n\n%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$project_id" "$session_id" "$digest")"

curl -sS -o /dev/null -m 5 \
  -X POST "${MEMORY_API_URL}/memories" \
  -H "Content-Type: application/json" \
  -H "Authorization: ApiKey ${MEMORY_API_KEY}" \
  -d "$(jq -nc \
        --arg content "$content" \
        --arg project "$project_id" \
        --arg session "$session_id" \
        '{ type: "summary", scope: "private", content: $content,
           importance: 0.7, project_id: $project, session_id: $session,
           source: "claude-code-session-end",
           tags: ["claude-code", "session-summary"] }')" \
  >/dev/null 2>&1 || true

exit 0
