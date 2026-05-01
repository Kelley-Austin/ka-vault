#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# ka-vault admin/setup.sh
#
# Activates the admin override on this machine. Once active, the
# block-sf-prod-deploy hook will allow Salesforce deployments to any org,
# including production, for the next 24 hours.
#
# Requirements:
#   - GitHub CLI (gh) installed and authenticated
#   - Your GitHub account must be an active member of the
#     Kelley-Austin/prod-deploy-admins team
#
# The override file (~/.config/ka-vault/admin-override) is the only mechanism.
# It is NOT committed, not shared, and has no effect on other machines.
# The hook re-verifies team membership every 24 hours and auto-expires.
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

OVERRIDE_FILE="${HOME}/.local/share/ka-vault/admin-override"
ADMIN_ORG="Kelley-Austin"
ADMIN_TEAM="prod-deploy-admins"

# ── Verify gh CLI ─────────────────────────────────────────────────────────────

GH="$(command -v gh 2>/dev/null || true)"
if [ -z "$GH" ]; then
  echo "Error: GitHub CLI (gh) is required." >&2
  echo "Install: brew install gh && gh auth login" >&2
  exit 1
fi

# ── Check authentication ──────────────────────────────────────────────────────

GH_USER="$("$GH" api user --jq '.login' 2>/dev/null || echo "")"
if [ -z "$GH_USER" ]; then
  echo "Error: Not authenticated with GitHub CLI." >&2
  echo "Run: gh auth login" >&2
  exit 1
fi

echo "Checking GitHub team membership for ${GH_USER}..."

# ── Verify team membership ────────────────────────────────────────────────────

MEMBERSHIP="$("$GH" api \
  "orgs/${ADMIN_ORG}/teams/${ADMIN_TEAM}/memberships/${GH_USER}" \
  --jq '.state' 2>/dev/null || echo "")"

if [ "$MEMBERSHIP" != "active" ]; then
  echo "" >&2
  echo "Error: ${GH_USER} is not an active member of ${ADMIN_ORG}/${ADMIN_TEAM}." >&2
  echo "" >&2
  echo "To request access, ask an org admin to add you to that team on GitHub." >&2
  echo "Team URL: https://github.com/orgs/${ADMIN_ORG}/teams/${ADMIN_TEAM}" >&2
  exit 1
fi

# ── Write override file ───────────────────────────────────────────────────────

mkdir -p "$(dirname "$OVERRIDE_FILE")"
printf 'allowed|%s\n' "$(date +%s)" > "$OVERRIDE_FILE"

echo ""
echo "✓ Admin override activated for ${GH_USER}."
echo ""
echo "  Override file : ${OVERRIDE_FILE}"
echo "  Valid for     : 24 hours (hook re-verifies team membership at expiry)"
echo "  Scope         : this machine only — does not affect other workstations"
echo ""
echo "  To deactivate early, run:"
echo "    bash $(dirname "${BASH_SOURCE[0]}")/disable.sh"
echo ""
echo "  All production deployments from Claude Code are now allowed."
echo "  Remember: production deployments are your responsibility."
