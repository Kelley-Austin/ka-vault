#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ka-vault install.sh
#
# Installs the sf-prod-guard Claude Code plugin for your user, so the guard
# applies to every Claude Code session on this machine, in every project.
# It also removes the guard registration of older ka-vault versions.
#
# Run once per workstation:
#   bash install.sh
#
# You can run it again safely. Plugin updates arrive automatically after that.
#
# Environment:
#   KA_VAULT_MARKETPLACE  Marketplace source. Default: Kelley-Austin/ka-vault
#                         (GitHub). A local path to this repo also works.
#   CLAUDE_CONFIG_DIR     Claude Code reads user settings from here when set.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKETPLACE_SOURCE="${KA_VAULT_MARKETPLACE:-Kelley-Austin/ka-vault}"
MARKETPLACE_NAME="ka-vault"
PLUGIN="sf-prod-guard@${MARKETPLACE_NAME}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
GLOBAL_SETTINGS="${CLAUDE_DIR}/settings.json"
OLD_HOOK_DIR="${HOME}/.local/share/ka-vault/hooks"
SRC_BACKUP_HELPER="${REPO_DIR}/bin/cheese-backup-then-modify"
DEST_BIN_DIR="${HOME}/.local/bin"
DEST_BACKUP_HELPER="${DEST_BIN_DIR}/cheese-backup-then-modify"

# ── 1. Verify requirements ────────────────────────────────────────────────────

for tool in claude jq; do
  if ! command -v "$tool" &>/dev/null; then
    echo "Error: install.sh needs '${tool}'." >&2
    [ "$tool" = jq ] && echo "       Install it: brew install jq" >&2
    [ "$tool" = claude ] && echo "       Install Claude Code: https://code.claude.com/docs/en/setup" >&2
    exit 1
  fi
done
if ! command -v node &>/dev/null; then
  echo "⚠️  Node.js is not on your PATH. The guard needs Node.js 18 or later (the sf CLI needs it too)." >&2
  echo "   Without Node.js, the guard blocks every Bash command that can be a Salesforce command." >&2
fi
mkdir -p "$CLAUDE_DIR"
[ -f "$GLOBAL_SETTINGS" ] || echo '{}' > "$GLOBAL_SETTINGS"

# Hooks that are disabled never run. Stop before a change.
if [ "$(jq -r '.disableAllHooks // false' "$GLOBAL_SETTINGS")" = "true" ]; then
  echo "Error: ${GLOBAL_SETTINGS} sets \"disableAllHooks\": true, so Claude Code never runs the guard." >&2
  echo "       Remove that setting, then run install.sh again." >&2
  exit 1
fi

# ── 2. Install or update the plugin ──────────────────────────────────────────

echo "Adding the ${MARKETPLACE_NAME} plugin marketplace (${MARKETPLACE_SOURCE})..."
claude plugin marketplace add "$MARKETPLACE_SOURCE" --scope user >/dev/null
claude plugin marketplace update "$MARKETPLACE_NAME" >/dev/null

plugin_json() { claude plugin list --json 2>/dev/null | jq -c --arg id "$PLUGIN" '[.[] | select(.id == $id and .scope == "user")][0] // empty'; }

if [ -z "$(plugin_json)" ]; then
  echo "Installing ${PLUGIN}..."
  claude plugin install "$PLUGIN" --scope user >/dev/null
else
  echo "Updating ${PLUGIN}..."
  claude plugin update "$PLUGIN" --scope user >/dev/null
fi
INFO="$(plugin_json)"
if [ -z "$INFO" ]; then
  echo "Error: ${PLUGIN} is not installed after the install step." >&2
  exit 1
fi
if [ "$(jq -r '.enabled' <<<"$INFO")" != "true" ]; then
  claude plugin enable "$PLUGIN" --scope user >/dev/null
  INFO="$(plugin_json)"
fi
if [ "$(jq -r '.enabled' <<<"$INFO")" != "true" ]; then
  echo "Error: ${PLUGIN} is installed but not enabled." >&2
  exit 1
fi
PLUGIN_ROOT="$(jq -r '.installPath' <<<"$INFO")"
echo "✓ ${PLUGIN} is installed and enabled (${PLUGIN_ROOT})"

# ── 3. Self-test the installed plugin ────────────────────────────────────────
# Run the hook command from hooks/hooks.json. A deploy with no target must give
# exactly exit 2 (block). A harmless command must give exactly exit 0.

HOOK_CMD="$(jq -r '.hooks.PreToolUse[] | select(.matcher == "Bash") | .hooks[] | .command' "${PLUGIN_ROOT}/hooks/hooks.json" | head -1)"
HOOK_CMD="${HOOK_CMD//\$\{CLAUDE_PLUGIN_ROOT\}/$PLUGIN_ROOT}"
set +e
printf '%s' '{"tool_input":{"command":"sf project deploy start"}}' | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$HOOK_CMD" >/dev/null 2>&1
RC_DEPLOY=$?
printf '%s' '{"tool_input":{"command":"git status"}}' | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" /bin/sh -c "$HOOK_CMD" >/dev/null 2>&1
RC_SAFE=$?
set -e
if [ "$RC_DEPLOY" -ne 2 ] || [ "$RC_SAFE" -ne 0 ]; then
  echo "Error: guard self-test failed (deploy test exit ${RC_DEPLOY}, expected 2; harmless test exit ${RC_SAFE}, expected 0)." >&2
  echo "       The old guard registration is unchanged. Do not use Claude Code for Salesforce work until this is fixed." >&2
  exit 1
fi
echo "✓ Self-test passed (a deploy with no --target-org is blocked; git status is allowed)"

# ── 4. Remove the guard of older ka-vault versions ───────────────────────────
# Older versions registered the hook directly in settings.json. With the plugin
# installed, that registration would run the guard a second time.

TMP_SETTINGS="$(mktemp "${GLOBAL_SETTINGS}.XXXXXX")"
jq '
  if .hooks.PreToolUse then
    .hooks.PreToolUse = [ .hooks.PreToolUse[]
      | .hooks = [ (.hooks // [])[] | select(((.command // "") | contains("block-sf-prod-deploy")) | not) ]
      | select((.hooks | length) > 0) ]
  else . end
' "$GLOBAL_SETTINGS" > "$TMP_SETTINGS"
jq -e . "$TMP_SETTINGS" >/dev/null
if cmp -s "$TMP_SETTINGS" <(jq . "$GLOBAL_SETTINGS"); then
  rm -f "$TMP_SETTINGS"
else
  mv "$TMP_SETTINGS" "$GLOBAL_SETTINGS"
  echo "✓ Removed the old guard registration from ${GLOBAL_SETTINGS}"
fi
if [ -d "$OLD_HOOK_DIR" ]; then
  rm -rf "$OLD_HOOK_DIR"
  echo "✓ Removed the old guard files from ${OLD_HOOK_DIR}"
fi
rm -f "${HOME}/.local/share/ka-vault/admin-override"

# ── 5. Helpers ────────────────────────────────────────────────────────────────

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

# Allowlist Bash(git *) globally so git commands don't hit permission prompts
# in any Claude Code session — including project-cwd sessions launched by CHEESE.
if jq -e '(.permissions.allow // []) | index("Bash(git *)")' "$GLOBAL_SETTINGS" >/dev/null 2>&1; then
  echo "✓ Bash(git *) already in ${GLOBAL_SETTINGS} allow list — nothing to do"
else
  # Write a temporary file, then rename it. A failed write never truncates the settings.
  TMP_SETTINGS="$(mktemp "${GLOBAL_SETTINGS}.XXXXXX")"
  jq '.permissions.allow //= [] | .permissions.allow += ["Bash(git *)"]' "$GLOBAL_SETTINGS" > "$TMP_SETTINGS"
  jq -e . "$TMP_SETTINGS" >/dev/null
  mv "$TMP_SETTINGS" "$GLOBAL_SETTINGS"
  echo "✓ Bash(git *) added to ${GLOBAL_SETTINGS} allow list"
fi

# ── 6. Done ───────────────────────────────────────────────────────────────────

if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  echo "  Note: CLAUDE_CONFIG_DIR is set, so the plugin is installed for ${CLAUDE_DIR}."
  echo "  If you also start Claude Code without CLAUDE_CONFIG_DIR, run install.sh again without it."
fi
echo ""
echo "ka-vault is installed. The production guard is active for every Claude Code"
echo "session on this machine. Restart open Claude Code sessions to load it."
echo "A user can turn a plugin off. To make the guard mandatory, see \"Managed settings\" in README.md."
