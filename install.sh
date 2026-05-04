#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ka-vault install.sh
#
# Installs the block-sf-prod-deploy hook into Claude Code's GLOBAL user
# settings (~/.claude/settings.json) so the guard applies to every Claude Code
# session on this machine, regardless of which project is open.
#
# Run once per workstation:
#   bash install.sh
#
# Re-running is safe (idempotent — will not duplicate the hook entry).
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_HOOK="${REPO_DIR}/.claude/hooks/block-sf-prod-deploy.sh"
SRC_BACKUP_HELPER="${REPO_DIR}/bin/cheese-backup-then-modify"
DEST_DIR="${HOME}/.local/share/ka-vault/hooks"
DEST_HOOK="${DEST_DIR}/block-sf-prod-deploy.sh"
DEST_BIN_DIR="${HOME}/.local/bin"
DEST_BACKUP_HELPER="${DEST_BIN_DIR}/cheese-backup-then-modify"
GLOBAL_SETTINGS="${HOME}/.claude/settings.json"

# ── 1. Verify requirements ────────────────────────────────────────────────────

if ! command -v jq &>/dev/null; then
  echo "Error: 'jq' is required for installation. Install it: brew install jq" >&2
  exit 1
fi

if [ ! -f "$SRC_HOOK" ]; then
  echo "Error: hook script not found at ${SRC_HOOK}" >&2
  exit 1
fi

# ── 2. Copy hook to a stable location ────────────────────────────────────────

mkdir -p "$DEST_DIR"
cp "$SRC_HOOK" "$DEST_HOOK"
chmod +x "$DEST_HOOK"
echo "✓ Hook copied to ${DEST_HOOK}"

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

# ── 3. Register hook in ~/.claude/settings.json ───────────────────────────────

mkdir -p "$(dirname "$GLOBAL_SETTINGS")"

# Seed settings file if it doesn't exist
if [ ! -f "$GLOBAL_SETTINGS" ]; then
  echo '{}' > "$GLOBAL_SETTINGS"
fi

# Skip if ka-vault hook is already registered
if grep -q "block-sf-prod-deploy" "$GLOBAL_SETTINGS" 2>/dev/null; then
  echo "✓ Hook already registered in ${GLOBAL_SETTINGS} — nothing to do"
else
  HOOK_CMD="bash \"${DEST_HOOK}\""
  UPDATED="$(jq --arg cmd "$HOOK_CMD" '
    .hooks.PreToolUse //= [] |
    .hooks.PreToolUse += [{"matcher": "Bash", "hooks": [{"type": "command", "command": $cmd, "timeout": 30}]}]
  ' "$GLOBAL_SETTINGS")"
  printf '%s\n' "$UPDATED" > "$GLOBAL_SETTINGS"
  echo "✓ Hook registered in ${GLOBAL_SETTINGS}"
fi

# ── 4. Done ───────────────────────────────────────────────────────────────────

echo ""
echo "ka-vault is installed. The production deployment guard is now active for"
echo "every Claude Code session on this machine."
echo ""
echo "Restart any open Claude Code sessions for the change to take effect."
echo ""
echo "If you are an admin and need to disable the guard temporarily:"
echo "  bash ${REPO_DIR}/admin/setup.sh"
