#!/usr/bin/env bash
# AstraMemory pre-compact capture hook.
#
# Triggered by Claude Code right before the conversation is auto-compacted.
# Reads the hook payload from stdin (JSON with transcript_path, session_id,
# cwd, etc.), extracts the last N assistant + user messages as a plain-text
# digest, and stores it as a memory of type=summary so the substance survives
# the compaction window.
#
# Hard requirements:
#   - AstraMemory API reachable at MEMORY_API_URL  (default: http://localhost:5201)
#   - MEMORY_API_KEY (default: dev-bootstrap-local)
# Soft requirement: jq for parsing transcript. Falls back to a no-op if absent.
#
# Never fails the hook chain — every error path is swallowed so Claude Code
# never blocks compaction because of memory plumbing.

set +e
set -u

# Load profile (.env.local / .env.azuredev / .env / plugin.json defaultEnv).
# shellcheck source=./_load-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/_load-env.sh"

MEMORY_API_URL="${MEMORY_API_URL:-http://localhost:5201}"
MEMORY_API_KEY="${MEMORY_API_KEY:-dev-bootstrap-local}"
MAX_TURNS="${MEMORY_PRECOMPACT_MAX_TURNS:-20}"
MAX_CHARS="${MEMORY_PRECOMPACT_MAX_CHARS:-12000}"

# Slurp hook payload (Claude Code feeds JSON on stdin).
payload="$(cat 2>/dev/null || true)"
if [ -z "$payload" ]; then
  exit 0
fi

# AstraMemory must be reachable, otherwise quietly bail.
if ! curl -sS -o /dev/null -m 2 "${MEMORY_API_URL}/health"; then
  exit 0
fi

# jq is required to parse the transcript. If missing, bail quietly so we
# don't block compaction on tooling.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

transcript_path="$(printf '%s' "$payload" | jq -r '.transcript_path // empty')"
session_id="$(printf '%s' "$payload" | jq -r '.session_id // "unknown"')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"

[ -z "$transcript_path" ] && exit 0
[ ! -f "$transcript_path" ] && exit 0

project_id="$(basename "${cwd:-$PWD}")"

# Tail the last N user+assistant text turns, strip JSON, concatenate.
digest="$(
  tail -n "$((MAX_TURNS * 4))" "$transcript_path" 2>/dev/null \
    | jq -r 'select(.role == "user" or .role == "assistant") | "[\(.role)] \(.content // .text // "")"' 2>/dev/null \
    | tail -n "$MAX_TURNS" \
    | head -c "$MAX_CHARS"
)"

[ -z "$digest" ] && exit 0

content="$(printf 'Pre-compact session digest (%s)\n\nProject: %s\nSession: %s\n\n%s\n' \
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
           source: "claude-code-precompact",
           tags: ["claude-code", "pre-compact", "session-digest"] }')" \
  >/dev/null 2>&1 || true

exit 0
