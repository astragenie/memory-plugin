#!/usr/bin/env bash
# Shared helper for AstraMemory transcript ingest hooks.
#
# Usage (production):
#   _ingest-transcript.sh --event pre_compact|session_end|subagent_stop \
#                         [--max-turns N] [--max-chars N]
#   Reads Claude Code hook payload (JSON) on stdin.
#   Always exits 0 (never block compaction / session close).
#
# Usage (test):
#   _ingest-transcript.sh --scrub-only <file>
#   Reads file content, prints JSON {"text": "...", "hits": N} to stdout.

set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---- scrub-only mode --------------------------------------------------------
if [ "${1:-}" = "--scrub-only" ]; then
  input="$(cat "${2:?scrub-only requires a file arg}")"
  hits=0

  scrub_pattern() {
    local pattern="$1" replacement="$2"
    # Count matches first, then substitute.
    local n
    n="$(printf '%s' "$input" | grep -oE "$pattern" | wc -l | tr -d ' ')"
    # Defensive: if `wc` returns blank (rare, but `set -u` would explode on the
    # arithmetic compare below), default to 0.
    n="${n:-0}"
    if [ "$n" -gt 0 ]; then
      hits=$((hits + n))
      # Use `#` as the sed delimiter — none of the four scrub patterns contain `#`,
      # whereas `|` collides with the alternation inside the generic-secret pattern
      # and would prematurely close the `s///` expression.
      input="$(printf '%s' "$input" | sed -E "s#$pattern#$replacement#g")"
    fi
  }

  scrub_pattern 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+' '[redacted:jwt]'
  scrub_pattern 'AKIA[0-9A-Z]{16}'                                          '[redacted:aws-key]'
  scrub_pattern 'sk-(ant-)?[A-Za-z0-9_-]{20,}'                              '[redacted:anthropic-key]'
  scrub_pattern '(api[_-]?key|secret|password|token)[[:space:]]*[:=][[:space:]]*['"'"'"]?[A-Za-z0-9_./+=-]{16,}' '[redacted:generic-secret]'

  # JSON-safe output.
  printf '%s' "$input" | jq -Rs --argjson hits "$hits" '{text: ., hits: $hits}'
  exit 0
fi

# ---- production mode --------------------------------------------------------
. "$SCRIPT_DIR/_load-env.sh"

EVENT=""
MAX_TURNS=20
MAX_CHARS=12000
while [ $# -gt 0 ]; do
  case "$1" in
    --event)     EVENT="$2"; shift 2 ;;
    --max-turns) MAX_TURNS="$2"; shift 2 ;;
    --max-chars) MAX_CHARS="$2"; shift 2 ;;
    *)           shift ;;
  esac
done
[ -z "$EVENT" ] && exit 0

MEMORY_API_URL="${MEMORY_API_URL:-http://localhost:5201}"
RETRIES="${MEMORY_INGEST_RETRIES:-2}"
RETRY_SLEEP="${MEMORY_INGEST_RETRY_SLEEP:-1}"

payload="$(cat 2>/dev/null || true)"
[ -z "$payload" ] && exit 0

command -v jq >/dev/null 2>&1 || exit 0

# Need a fresh Bearer.
BEARER="$("${CLAUDE_PLUGIN_ROOT:-}/bin/memory-refresh" 2>/dev/null)"
[ -z "${BEARER:-}" ] && exit 0

transcript_path="$(printf '%s' "$payload" | jq -r '.transcript_path // empty')"
session_id="$(printf '%s' "$payload" | jq -r '.session_id // "unknown"')"
cwd="$(printf '%s' "$payload" | jq -r '.cwd // empty')"
agent_type="$(printf '%s' "$payload" | jq -r '.agent_type // empty')"
[ -z "$transcript_path" ] || [ ! -f "$transcript_path" ] && exit 0

project_id="$(basename "${cwd:-$PWD}")"

# Pull last N turns as JSON array of {role,text,ts}.
turns_json="$(
  tail -n "$((MAX_TURNS * 4))" "$transcript_path" 2>/dev/null \
    | jq -c 'select(.role == "user" or .role == "assistant")
             | {role: .role, text: (.content // .text // ""), ts: (.timestamp // null)}' 2>/dev/null \
    | tail -n "$MAX_TURNS" \
    | jq -sc '.'
)"
[ -z "$turns_json" ] || [ "$turns_json" = "[]" ] && exit 0

# Client-side scrub each turn's text.
# `jq -c '.[]'` emits one line per element so the while loop sees one object per iteration.
tmp_scrub_input="$(mktemp)"
trap 'rm -f "$tmp_scrub_input"' EXIT
scrubbed_turns_json="$(
  printf '%s' "$turns_json" | jq -c '.[]' | while IFS= read -r t; do
    printf '%s' "$t" | jq -r '.text' > "$tmp_scrub_input"
    scrubbed="$("$SCRIPT_DIR/_ingest-transcript.sh" --scrub-only "$tmp_scrub_input" 2>/dev/null)"
    [ -z "$scrubbed" ] && scrubbed="$(jq -nc --rawfile s "$tmp_scrub_input" '{text: $s, hits: 0}')"
    printf '%s' "$t" | jq -c --argjson s "$scrubbed" '.text = $s.text | .scrub_hits = $s.hits'
  done | jq -sc '.'
)"

total_client_hits="$(printf '%s' "$scrubbed_turns_json" | jq '[.[].scrub_hits] | add // 0')"
stripped_turns_json="$(printf '%s' "$scrubbed_turns_json" | jq -c '[.[] | del(.scrub_hits)]')"

body="$(jq -nc \
  --arg event "$EVENT" \
  --arg session "$session_id" \
  --arg project "$project_id" \
  --arg agent "$agent_type" \
  --arg cwd "$cwd" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson turns "$stripped_turns_json" \
  --argjson hits "$total_client_hits" \
  '{
     event: $event, project_id: $project, session_id: $session,
     agent_type: (if ($agent | length) > 0 then $agent else null end),
     cwd: $cwd, captured_at: $ts, turns: $turns,
     client_scrub_applied: true, client_scrub_hits: $hits,
     client_version: "0.3.0"
   }')"

attempt=0
while [ "$attempt" -lt "$RETRIES" ]; do
  attempt=$((attempt + 1))
  # Use mktemp so concurrent hook fires (e.g. SubagentStop + SessionEnd back-to-back)
  # don't clobber each other's response file. $$ alone is not unique enough.
  resp_file="$(mktemp 2>/dev/null || echo "/tmp/_memory_ingest_resp.$$")"
  http_code="$(curl -sS -o "$resp_file" -w '%{http_code}' \
        -m 10 \
        -X POST "${MEMORY_API_URL}/ingest/transcript" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${BEARER}" \
        -d "$body" 2>/dev/null)"
  rm -f "$resp_file" 2>/dev/null
  case "$http_code" in
    2*)         exit 0 ;;
    4*)         echo "memory-ingest: ${http_code} (no retry)" >&2; exit 0 ;;  # final, no retry
    *)          [ "$attempt" -lt "$RETRIES" ] && sleep "$RETRY_SLEEP" ;;
  esac
done

exit 0
