#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ka-vault: Claude Code PreToolUse hook for the Bash tool.
#
# Blocks every Salesforce CLI command that can change a production org.
# Allows sandboxes, scratch orgs, Developer Edition orgs, trial orgs, and
# allowlisted demo orgs (IDO/SDO). The decision logic is in sf-prod-guard.mjs.
#
# Exit codes (Claude Code hook contract):
#   0 = allow.
#   2 = block. Claude Code shows stderr to the model.
# This wrapper never exits with a different code. A crash in the Node script
# becomes exit 2 (fail closed). The wrapper does not need jq.
# ──────────────────────────────────────────────────────────────────────────────

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd)"
if [ -z "$HERE" ] || [ ! -f "$HERE/sf-prod-guard.mjs" ]; then
  echo "ka-vault guard: BLOCKED. The guard cannot find sf-prod-guard.mjs next to this script. Run install.sh again." >&2
  exit 2
fi

INPUT="$(cat)"

find_node() {
  local c
  c="$(command -v node 2>/dev/null)"
  if [ -n "$c" ] && [ -x "$c" ]; then printf '%s' "$c"; return; fi
  for c in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node \
           "$HOME/.volta/bin/node" /usr/local/lib/sf/bin/node \
           "$HOME/.local/share/sf/client/bin/node" "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$c" ]; then printf '%s' "$c"; return; fi
  done
  # The sf installer ships its own Node next to the sf binary.
  local sfbin sfdir
  sfbin="$(command -v sf 2>/dev/null)"
  if [ -n "$sfbin" ]; then
    sfbin="$(readlink -f "$sfbin" 2>/dev/null || printf '%s' "$sfbin")"
    sfdir="$(dirname "$sfbin")"
    for c in "$sfdir/node" "$sfdir/../bin/node" "$sfdir/../client/bin/node"; do
      if [ -x "$c" ]; then printf '%s' "$c"; return; fi
    done
  fi
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  # Without Node the guard cannot parse the command. Block anything that can be
  # a Salesforce command. Allow everything else, so non-Salesforce work goes on.
  # Read only the command field (jq, or plutil on macOS), so that a cwd or a
  # transcript path that contains "sf" does not block harmless commands. If
  # neither tool can read it, inspect the whole payload (fail closed).
  CMD_TEXT=""
  if command -v jq >/dev/null 2>&1; then
    CMD_TEXT="$(jq -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null)"
  elif [ -x /usr/bin/plutil ]; then
    CMD_TEXT="$(/usr/bin/plutil -extract tool_input.command raw -o - - <<<"$INPUT" 2>/dev/null)"
  fi
  [ -z "$CMD_TEXT" ] && CMD_TEXT="$INPUT"
  shopt -s nocasematch
  STRIPPED="${CMD_TEXT//[\'\"\\]/}"
  # Also block text that can hide an sf call: ANSI-C quoting ($'\x73\x66'),
  # and an expansion or a backtick in the command-name position (at the start,
  # or after ; & | ( { or a newline, after optional NAME=value words).
  CMD_POS_EXPANSION=$'(^|[;&|({\n`])[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*["\']?(\\$|`)'
  if [[ "$STRIPPED" == *sf* || "$STRIPPED" == *salesforce* ]] \
     || [[ "$CMD_TEXT" == *"\$'"* ]] \
     || [[ "$CMD_TEXT" =~ $CMD_POS_EXPANSION ]]; then
    echo "ka-vault guard: BLOCKED. Node.js is not available to the hook, so the guard cannot check Salesforce commands. Install Node.js (the sf CLI needs it too), then restart Claude Code." >&2
    exit 2
  fi
  exit 0
fi

# Hard deadline outside Node: perl sets a 50 s alarm, then execs Node. The
# alarm survives exec and kills Node even when Node is busy in synchronous
# code. Claude Code's hook timeout is 60 s, and a killed hook does not block.
PERL="$(command -v perl 2>/dev/null)"
[ -z "$PERL" ] && [ -x /usr/bin/perl ] && PERL=/usr/bin/perl
if [ -n "$PERL" ]; then
  "$PERL" -e 'alarm 50; exec @ARGV or exit 126' "$NODE" "$HERE/sf-prod-guard.mjs" <<<"$INPUT"
else
  "$NODE" "$HERE/sf-prod-guard.mjs" <<<"$INPUT"
fi
rc=$?
if [ "$rc" -eq 0 ]; then exit 0; fi
if [ "$rc" -ne 2 ]; then
  echo "ka-vault guard: BLOCKED. The guard stopped with exit code $rc, so it cannot confirm that the command is safe." >&2
fi
exit 2
