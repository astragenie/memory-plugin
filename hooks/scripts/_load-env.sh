#!/usr/bin/env bash
# Shared env loader for memory hooks.
#
# Resolution order, first match wins:
#   1. $MEMORY_ENV explicitly set in the shell  -> $CLAUDE_PLUGIN_ROOT/.env.$MEMORY_ENV
#   2. $CLAUDE_PLUGIN_ROOT/.env                 -> gitignored user override
#   3. defaultEnv from plugin.json              -> $CLAUDE_PLUGIN_ROOT/.env.<defaultEnv>
#   4. $CLAUDE_PLUGIN_ROOT/.env.local           -> hard fallback
#
# Loaded values are exported so the rest of the hook script can use them
# without re-sourcing.

set +e
set -u

_memory_load_env() {
  local plugin_root="${CLAUDE_PLUGIN_ROOT:-}"
  if [ -z "$plugin_root" ]; then
    # Fall back to the directory two levels above this script.
    plugin_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  fi

  local candidate=""

  if [ -n "${MEMORY_ENV:-}" ]; then
    candidate="$plugin_root/.env.$MEMORY_ENV"
  fi

  if [ -z "$candidate" ] || [ ! -f "$candidate" ]; then
    if [ -f "$plugin_root/.env" ]; then
      candidate="$plugin_root/.env"
    fi
  fi

  if [ -z "$candidate" ] || [ ! -f "$candidate" ]; then
    if command -v jq >/dev/null 2>&1 && [ -f "$plugin_root/.claude-plugin/plugin.json" ]; then
      local default_env
      default_env="$(jq -r '.defaultEnv // empty' "$plugin_root/.claude-plugin/plugin.json" 2>/dev/null)"
      if [ -n "$default_env" ] && [ -f "$plugin_root/.env.$default_env" ]; then
        candidate="$plugin_root/.env.$default_env"
      fi
    fi
  fi

  if [ -z "$candidate" ] || [ ! -f "$candidate" ]; then
    candidate="$plugin_root/.env.local"
  fi

  if [ -f "$candidate" ]; then
    # shellcheck disable=SC1090
    set -a
    . "$candidate"
    set +a
  fi
}

_memory_load_env
