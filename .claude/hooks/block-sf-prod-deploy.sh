#!/usr/bin/env bash
# PreToolUse/Bash hook: block any `sf`/`sfdx` deploy targeting a production org.
#
# Allowed targets (any one is sufficient):
#   - Sandbox          (isSandbox=true)
#   - Scratch org      (isScratch=true)
#   - Developer / Partner Developer / Personal Edition
#   - Trial / pre-release / signup orgs (TrialExpirationDate set)
#   - Instance URLs matching .develop / .scratch / .pre.my.salesforce.com
# Anything else is treated as production and denied.
# Fails closed: if the org cannot be resolved, the deploy is denied.
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

# --- Fast-path allows (no SOQL needed) ---

# Sandbox or scratch.
if [ "$IS_SANDBOX" = "true" ] || [ "$IS_SCRATCH" = "true" ]; then
  exit 0
fi

# URL pattern allows: Sandbox / Developer Edition / scratch / pre-release pods.
# These subdomains are reserved by Salesforce and authoritative even when sf's
# cached auth data lies about isSandbox.
case "$INSTANCE_URL" in
  *.sandbox.my.salesforce.com|*.sandbox.my.salesforce.com/*) exit 0 ;;
  *.develop.my.salesforce.com|*.develop.my.salesforce.com/*) exit 0 ;;
  *.scratch.my.salesforce.com|*.scratch.my.salesforce.com/*) exit 0 ;;
  *.pre.my.salesforce.com|*.pre.my.salesforce.com/*)         exit 0 ;;
  *prerellogin.pre.salesforce.com*)                          exit 0 ;;
esac

# --- Authoritative SOQL check ---
# Query Organization for OrganizationType + TrialExpirationDate.
# Allow Developer Edition variants and any org with a trial expiration date.
ORG_SOQL_ARGS=("data" "query" "--query" "SELECT IsSandbox, OrganizationType, TrialExpirationDate FROM Organization" "--json")
if [ -n "$TARGET_ORG" ]; then
  ORG_SOQL_ARGS+=("--target-org" "$TARGET_ORG")
fi

ORG_SOQL_JSON="$("$SF_BIN" "${ORG_SOQL_ARGS[@]}" 2>/dev/null)"

if [ -z "$ORG_SOQL_JSON" ] || ! printf '%s' "$ORG_SOQL_JSON" | jq -e '.result.records[0]' >/dev/null 2>&1; then
  emit_block "BLOCKED: Could not query Organization on target='${TARGET_ORG:-<default>}' (alias='${ALIAS}', instanceUrl='${INSTANCE_URL}'). Cannot confirm this is a Developer Edition, sandbox, scratch, or trial org. Production deploys are forbidden — verify auth and retry."
fi

ORG_TYPE="$(printf '%s' "$ORG_SOQL_JSON" | jq -r '.result.records[0].OrganizationType // ""')"
TRIAL_EXP="$(printf '%s' "$ORG_SOQL_JSON" | jq -r '.result.records[0].TrialExpirationDate // ""')"

# Developer Edition family.
case "$ORG_TYPE" in
  "Developer Edition"|"Partner Developer Edition"|"Personal Edition") exit 0 ;;
esac

# Trial / pre-release / signup orgs always have TrialExpirationDate set.
if [ -n "$TRIAL_EXP" ] && [ "$TRIAL_EXP" != "null" ]; then
  exit 0
fi

# Otherwise: real production edition (Enterprise / Unlimited / Performance / Group / Professional / Base / etc.) with no trial.
emit_block "BLOCKED: deployment to a PRODUCTION org is forbidden. target='${TARGET_ORG:-<default>}' alias='${ALIAS}' username='${USERNAME}' instanceUrl='${INSTANCE_URL}' OrganizationType='${ORG_TYPE}' isSandbox=${IS_SANDBOX} isScratch=${IS_SCRATCH} TrialExpirationDate='${TRIAL_EXP}'. Production deployments must run from a CI pipeline or out-of-band, never from Claude Code. NO EXCEPTIONS."
