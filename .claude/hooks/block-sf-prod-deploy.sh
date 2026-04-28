#!/usr/bin/env bash
# PreToolUse/Bash hook: block any `sf`/`sfdx` deploy targeting a production org.
# Decision rule: production = isSandbox=false AND isScratch=false.
# Exits 0 always; emits PreToolUse permissionDecision JSON to deny.

set -uo pipefail

INPUT="$(cat)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"

[ -z "$CMD" ] && exit 0

# Match deploy subcommands of sf or sfdx, regardless of leading wrappers (cd && ..., env VAR=..., etc.).
# Covered: sf project deploy [start|validate|quick|...], sf deploy, legacy sfdx force:source:deploy / force:mdapi:deploy / force:source:push.
if ! printf '%s' "$CMD" | grep -qiE '(^|[[:space:]]|;|&&|\|\||`|\()(sf|sfdx)[[:space:]]+(project[[:space:]]+deploy|deploy([[:space:]]|$)|force:source:deploy|force:mdapi:deploy|force:source:push)'; then
  exit 0
fi

# Ignore commands wrapped in echo/printf/cat heredocs (documentation, not execution).
FIRST_TOKEN="$(printf '%s' "$CMD" | sed -E 's/^[[:space:]]*//' | awk '{print $1}')"
case "$FIRST_TOKEN" in
  echo|printf|cat|"#"*) exit 0 ;;
esac

# Pull --target-org / --targetusername / -o / -u value (supports `=` and space separators).
TARGET_ORG=""
if [[ "$CMD" =~ (--target-org|--targetusername)[[:space:]=]+([^[:space:]\"\']+) ]]; then
  TARGET_ORG="${BASH_REMATCH[2]}"
elif [[ "$CMD" =~ (^|[[:space:]])(-o|-u)[[:space:]=]+([^[:space:]\"\']+) ]]; then
  TARGET_ORG="${BASH_REMATCH[3]}"
fi

emit_block() {
  local reason="$1"
  jq -n --arg reason "$reason" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $reason
    }
  }'
  exit 0
}

# Resolve sf binary (PATH may differ inside hook shell).
SF_BIN="$(command -v sf || true)"
if [ -z "$SF_BIN" ]; then
  for cand in /opt/homebrew/bin/sf /usr/local/bin/sf "$HOME/.local/share/sf/bin/sf"; do
    [ -x "$cand" ] && SF_BIN="$cand" && break
  done
fi
if [ -z "$SF_BIN" ]; then
  emit_block "BLOCKED: 'sf' CLI not found on PATH inside hook shell. Cannot verify target org is non-production. Production deploys are forbidden."
fi

# Query target org. Fail closed: if we can't read isSandbox, assume production.
if [ -n "$TARGET_ORG" ]; then
  ORG_JSON="$("$SF_BIN" org display --target-org "$TARGET_ORG" --json 2>/dev/null)"
else
  ORG_JSON="$("$SF_BIN" org display --json 2>/dev/null)"
fi

if [ -z "$ORG_JSON" ] || ! printf '%s' "$ORG_JSON" | jq -e '.result' >/dev/null 2>&1; then
  emit_block "BLOCKED: Could not resolve target Salesforce org via 'sf org display' (target='${TARGET_ORG:-<default>}'). Cannot confirm this is non-production. Production deploys are forbidden — set/verify a sandbox or scratch alias and retry."
fi

IS_SANDBOX="$(printf '%s' "$ORG_JSON" | jq -r '.result.isSandbox // false')"
IS_SCRATCH="$(printf '%s' "$ORG_JSON" | jq -r '.result.isScratch // false')"
INSTANCE_URL="$(printf '%s' "$ORG_JSON" | jq -r '.result.instanceUrl // ""')"
USERNAME="$(printf '%s' "$ORG_JSON" | jq -r '.result.username // ""')"
ALIAS="$(printf '%s' "$ORG_JSON" | jq -r '.result.alias // ""')"

# Production = neither sandbox nor scratch.
if [ "$IS_SANDBOX" != "true" ] && [ "$IS_SCRATCH" != "true" ]; then
  emit_block "BLOCKED: deployment to a PRODUCTION org is forbidden. target='${TARGET_ORG:-<default>}' alias='${ALIAS}' username='${USERNAME}' instanceUrl='${INSTANCE_URL}' isSandbox=${IS_SANDBOX} isScratch=${IS_SCRATCH}. Production deployments must run from a CI pipeline or out-of-band, never from Claude Code. NO EXCEPTIONS."
fi

exit 0
