#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ka-vault install.sh
#
# Installs the production guard into Claude Code's GLOBAL user settings
# (~/.claude/settings.json, or $CLAUDE_CONFIG_DIR/settings.json when set). The guard then applies to every Claude Code
# session on this machine, in every project.
#
# Run once per workstation, and again after you pull a new version:
#   bash install.sh
#
# You can run it again safely. It replaces old registrations of the guard
# and does not add duplicates.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_GUARD_DIR="${REPO_DIR}/guard"
SRC_BACKUP_HELPER="${REPO_DIR}/bin/cheese-backup-then-modify"
DEST_DIR="${HOME}/.local/share/ka-vault/hooks"
DEST_HOOK="${DEST_DIR}/block-sf-prod-deploy.sh"
DEST_BIN_DIR="${HOME}/.local/bin"
DEST_BACKUP_HELPER="${DEST_BIN_DIR}/cheese-backup-then-modify"
# Claude Code reads user settings from $CLAUDE_CONFIG_DIR when it is set.
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
GLOBAL_SETTINGS="${CLAUDE_DIR}/settings.json"
GUARD_FILES=(block-sf-prod-deploy.sh sf-prod-guard.mjs guard-lib.mjs sf-command-table.json allowed-orgs.json)

# ── 1. Verify requirements ────────────────────────────────────────────────────

if ! command -v jq &>/dev/null; then
  echo "Error: install.sh needs 'jq'. Install it: brew install jq" >&2
  exit 1
fi
for f in "${GUARD_FILES[@]}"; do
  if [ ! -f "${SRC_GUARD_DIR}/${f}" ]; then
    echo "Error: guard file not found: ${SRC_GUARD_DIR}/${f}" >&2
    exit 1
  fi
done
if ! command -v node &>/dev/null; then
  echo "⚠️  Node.js is not on your PATH. The guard needs Node.js (the sf CLI needs it too)." >&2
  echo "   Without Node.js, the guard blocks every Bash command that mentions Salesforce." >&2
fi

# ── 2. Copy the guard to a stable location ───────────────────────────────────

# Stage a full copy, test it, then publish each file with an atomic rename.
# A failed copy never leaves a truncated guard in place: the old version stays
# until the new one passes its test. The wrapper is published last.
mkdir -p "$DEST_DIR"
STAGE="$(mktemp -d "${DEST_DIR}/.staging.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
for f in "${GUARD_FILES[@]}"; do
  cp "${SRC_GUARD_DIR}/${f}" "${STAGE}/${f}"
  cmp -s "${SRC_GUARD_DIR}/${f}" "${STAGE}/${f}" || { echo "Error: copy of ${f} is incomplete." >&2; exit 1; }
done
chmod +x "${STAGE}/block-sf-prod-deploy.sh" "${STAGE}/sf-prod-guard.mjs"
set +e
printf '%s' '{"tool_input":{"command":"sf project deploy start"}}' | /bin/bash "${STAGE}/block-sf-prod-deploy.sh" >/dev/null 2>&1
RC_STAGE=$?
set -e
if [ "$RC_STAGE" -ne 2 ]; then
  echo "Error: the new guard failed its test before install (exit ${RC_STAGE}, expected 2). The old guard is unchanged." >&2
  exit 1
fi
for f in "${GUARD_FILES[@]}"; do
  [ "$f" = "block-sf-prod-deploy.sh" ] && continue
  mv -f "${STAGE}/${f}" "${DEST_DIR}/${f}"
done
mv -f "${STAGE}/block-sf-prod-deploy.sh" "$DEST_HOOK"
echo "✓ Guard installed in ${DEST_DIR}"

# Remove the admin override file from older versions. The override is gone.
rm -f "${HOME}/.local/share/ka-vault/admin-override"

# Install cheese-backup-then-modify onto PATH (~/.local/bin)
if [ -f "$SRC_BACKUP_HELPER" ]; then
  mkdir -p "$DEST_BIN_DIR"
  cp "$SRC_BACKUP_HELPER" "$DEST_BACKUP_HELPER"
  chmod +x "$DEST_BACKUP_HELPER"
  echo "✓ Backup helper copied to ${DEST_BACKUP_HELPER}"
  case ":${PATH}:" in
    *":${DEST_BIN_DIR}:"*) : ;;
    *) echo "  ⚠️  ${DEST_BIN_DIR} is not on your PATH. Add it to your shell rc:" >&2
       echo "       export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2 ;;
  esac
fi

# ── 3. Register the guard in ~/.claude/settings.json ─────────────────────────
# Remove every old guard registration (any path, any matcher), then add one
# correct entry. A plain text search could leave a broken path registered.

mkdir -p "$(dirname "$GLOBAL_SETTINGS")"
if [ ! -f "$GLOBAL_SETTINGS" ]; then
  echo '{}' > "$GLOBAL_SETTINGS"
fi

# Use an absolute path to bash, so the hook does not depend on PATH.
HOOK_CMD="/bin/bash \"${DEST_HOOK}\""
TMP_SETTINGS="$(mktemp "${GLOBAL_SETTINGS}.XXXXXX")"
jq --arg cmd "$HOOK_CMD" '
  .hooks //= {} |
  .hooks.PreToolUse = (
    [ (.hooks.PreToolUse // [])[]
      | .hooks = [ (.hooks // [])[] | select(((.command // "") | contains("block-sf-prod-deploy")) | not) ]
      | select((.hooks | length) > 0) ]
    + [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": $cmd, "timeout": 60 } ] } ]
  )
' "$GLOBAL_SETTINGS" > "$TMP_SETTINGS"
mv "$TMP_SETTINGS" "$GLOBAL_SETTINGS"

# Verify the result.
COUNT="$(jq --arg cmd "$HOOK_CMD" '[.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[] | select(.command == $cmd)] | length' "$GLOBAL_SETTINGS")"
if [ "$COUNT" != "1" ]; then
  echo "Error: the guard registration in ${GLOBAL_SETTINGS} is not correct (found ${COUNT} entries)." >&2
  exit 1
fi
echo "✓ Guard registered in ${GLOBAL_SETTINGS}"

# Hooks that are disabled never run. Refuse to report success.
if [ "$(jq -r '.disableAllHooks // false' "$GLOBAL_SETTINGS")" = "true" ]; then
  echo "Error: ${GLOBAL_SETTINGS} sets \"disableAllHooks\": true, so Claude Code never runs the guard." >&2
  echo "       Remove that setting, then run install.sh again." >&2
  exit 1
fi

# Self-test with the registered command. A deploy with no target must give
# exactly exit 2 (block). A harmless command must give exactly exit 0.
# Any other code (1, 126, 127, a signal) is a non-blocking failure.
set +e
printf '%s' '{"tool_input":{"command":"sf project deploy start"}}' | /bin/sh -c "$HOOK_CMD" >/dev/null 2>&1
RC_DEPLOY=$?
printf '%s' '{"tool_input":{"command":"git status"}}' | /bin/sh -c "$HOOK_CMD" >/dev/null 2>&1
RC_SAFE=$?
set -e
if [ "$RC_DEPLOY" -ne 2 ] || [ "$RC_SAFE" -ne 0 ]; then
  echo "Error: guard self-test failed (deploy test exit ${RC_DEPLOY}, expected 2; harmless test exit ${RC_SAFE}, expected 0)." >&2
  echo "       Do not use Claude Code for Salesforce work until this is fixed." >&2
  exit 1
fi
echo "✓ Self-test passed (a deploy with no --target-org is blocked; git status is allowed)"

# Allowlist Bash(git *) globally so git commands don't hit permission prompts
# in any Claude Code session — including project-cwd sessions launched by CHEESE.
if jq -e '(.permissions.allow // []) | index("Bash(git *)")' "$GLOBAL_SETTINGS" >/dev/null 2>&1; then
  echo "✓ Bash(git *) already in ${GLOBAL_SETTINGS} allow list — nothing to do"
else
  UPDATED="$(jq '.permissions.allow //= [] | .permissions.allow += ["Bash(git *)"]' "$GLOBAL_SETTINGS")"
  printf '%s\n' "$UPDATED" > "$GLOBAL_SETTINGS"
  echo "✓ Bash(git *) added to ${GLOBAL_SETTINGS} allow list"
fi

# ── 4. Done ───────────────────────────────────────────────────────────────────

if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  echo "  Note: CLAUDE_CONFIG_DIR is set, so the guard is registered in ${GLOBAL_SETTINGS}."
  echo "  If you also start Claude Code without CLAUDE_CONFIG_DIR, run install.sh again without it."
fi
echo ""
echo "ka-vault is installed. The production guard is active for every Claude Code"
echo "session on this machine. Restart open Claude Code sessions to load it."
