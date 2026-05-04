#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ka-vault admin/disable.sh
#
# Deactivates the admin override on this machine immediately.
# The production deployment guard resumes for the next Claude Code session.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

OVERRIDE_FILE="${HOME}/.local/share/ka-vault/admin-override"

if [ -f "$OVERRIDE_FILE" ]; then
  rm "$OVERRIDE_FILE"
  echo "✓ Admin override deactivated. Production deployments are now blocked."
else
  echo "No active admin override found at ${OVERRIDE_FILE}"
fi
