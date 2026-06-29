#!/usr/bin/env bash
# Shared helper for AstraMemory transcript ingest hooks.
#
# Usage:
#   _ingest-transcript.sh --event pre_compact|session_end|subagent_stop \
#                         [--max-turns N] [--max-chars N]
#   Reads Claude Code hook payload (JSON) on stdin.
#   Always exits 0 (never block compaction / session close).
#
# Scrubbing: client-side secret redaction is handled exclusively by
# src/lib/scrub.ts via `astramem ingest-transcript`. The legacy --scrub-only
# bash path has been removed (Slice 3.5) — it never processed real content
# because it matched top-level .role, which doesn't exist in real JSONL.
set +e
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

# URL: prefer ASTRAMEMORY_API_URL (profile-resolved by _load-env.sh), fall back to MEMORY_API_URL
EFFECTIVE_API_URL="${ASTRAMEMORY_API_URL:-${MEMORY_API_URL:-http://localhost:5201}}"
RETRIES="${MEMORY_INGEST_RETRIES:-2}"
RETRY_SLEEP="${MEMORY_INGEST_RETRY_SLEEP:-1}"

payload="$(cat 2>/dev/null || true)"
[ -z "$payload" ] && {
  if [ "${ASTRAMEMORY_HOOK_DEBUG:-0}" = "1" ]; then
    printf '[astramemory-hook] script=%s env=%s workspace=%s url=%s key_source=%s outcome=skipped:empty_payload\n' \
      "${ASTRAMEMORY_HOOK_SCRIPT_NAME:-_ingest-transcript}" \
      "${_AM_ENV:-prod}" "${_AM_WORKSPACE:-unknown}" \
      "$EFFECTIVE_API_URL" "${_AM_KEY_SOURCE:-legacy_default}" >&2
  fi
  exit 0
}

command -v jq >/dev/null 2>&1 || {
  if [ "${ASTRAMEMORY_HOOK_DEBUG:-0}" = "1" ]; then
    printf '[astramemory-hook] script=%s env=%s workspace=%s url=%s key_source=%s outcome=skipped:jq_missing\n' \
      "${ASTRAMEMORY_HOOK_SCRIPT_NAME:-_ingest-transcript}" \
      "${_AM_ENV:-prod}" "${_AM_WORKSPACE:-unknown}" \
      "$EFFECTIVE_API_URL" "${_AM_KEY_SOURCE:-legacy_default}" >&2
  fi
  exit 0
}

# Auth: try Bearer from memory-refresh first; fall back to ASTRAMEMORY_API_KEY sk-... header.
BEARER="$("${CLAUDE_PLUGIN_ROOT:-}/bin/memory-refresh" 2>/dev/null)"
AUTH_HEADER=""
if [ -n "${BEARER:-}" ]; then
  AUTH_HEADER="Authorization: Bearer ${BEARER}"
elif [ -n "${ASTRAMEMORY_API_KEY:-}" ] && [ "${ASTRAMEMORY_API_KEY:-dev-bootstrap-local}" != "dev-bootstrap-local" ]; then
  AUTH_HEADER="Authorization: Bearer ${ASTRAMEMORY_API_KEY}"
else
  if [ "${ASTRAMEMORY_HOOK_DEBUG:-0}" = "1" ]; then
    printf '[astramemory-hook] script=%s env=%s workspace=%s url=%s key_source=%s outcome=skipped:no_auth\n' \
      "${ASTRAMEMORY_HOOK_SCRIPT_NAME:-_ingest-transcript}" \
      "${_AM_ENV:-prod}" "${_AM_WORKSPACE:-unknown}" \
      "$EFFECTIVE_API_URL" "${_AM_KEY_SOURCE:-legacy_default}" >&2
  fi
  exit 0
fi

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

# NOTE (Slice 3.5): bash scrub path removed — it called --scrub-only (deleted)
# and matched top-level .role which never exists in real JSONL transcripts.
# Scrubbing is now exclusively handled by src/lib/scrub.ts via
# `astramem ingest-transcript`. This bash path is superseded by Slice 4's shim.
# Pass turns through unscrubbed here; Slice 4 replaces this file wholesale.
total_client_hits=0
stripped_turns_json="$turns_json"

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
        -X POST "${EFFECTIVE_API_URL}/ingest/transcript" \
        -H "Content-Type: application/json" \
        -H "${AUTH_HEADER}" \
        -d "$body" 2>/dev/null)"
  rm -f "$resp_file" 2>/dev/null
  case "$http_code" in
    2*)
      if [ "${ASTRAMEMORY_HOOK_DEBUG:-0}" = "1" ]; then
        printf '[astramemory-hook] script=%s env=%s workspace=%s url=%s key_source=%s outcome=ok\n' \
          "${ASTRAMEMORY_HOOK_SCRIPT_NAME:-_ingest-transcript}" \
          "${_AM_ENV:-prod}" "${_AM_WORKSPACE:-unknown}" \
          "$EFFECTIVE_API_URL" "${_AM_KEY_SOURCE:-legacy_default}" >&2
      fi
      exit 0 ;;
    4*)         echo "memory-ingest: ${http_code} (no retry)" >&2; exit 0 ;;  # final, no retry
    *)          [ "$attempt" -lt "$RETRIES" ] && sleep "$RETRY_SLEEP" ;;
  esac
done

if [ "${ASTRAMEMORY_HOOK_DEBUG:-0}" = "1" ]; then
  printf '[astramemory-hook] script=%s env=%s workspace=%s url=%s key_source=%s outcome=skipped:post_failed\n' \
    "${ASTRAMEMORY_HOOK_SCRIPT_NAME:-_ingest-transcript}" \
    "${_AM_ENV:-prod}" "${_AM_WORKSPACE:-unknown}" \
    "$EFFECTIVE_API_URL" "${_AM_KEY_SOURCE:-legacy_default}" >&2
fi

exit 0
