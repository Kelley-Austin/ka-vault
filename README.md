# ka-vault

Claude Code project hook that **blocks Salesforce deployments to production orgs**. No exceptions.

When this hook is active, Claude Code cannot run `sf project deploy`, `sf deploy`, or any legacy `sfdx force:source:deploy` / `force:mdapi:deploy` / `force:source:push` command against a real production org. Sandboxes, scratch orgs, Developer Edition orgs (including chartBuddy and other Dev Hubs), and trial / pre-release / signup orgs are allowed. The hook fails closed: if the target org cannot be resolved, the deploy is denied.

---

## Why

Production deployments must be deliberate human actions performed from a CI pipeline or an explicitly-supervised terminal session. They must not be triggered by an LLM agent, even an instructed one. This repo enforces that as a hard pre-tool gate, so the protection is mechanical rather than dependent on prompting.

---

## How it works

Claude Code supports `PreToolUse` hooks that run before a tool is executed. A hook can return JSON that denies permission to run the tool. This project ships:

```
.claude/
├── settings.json                   # registers the hook (project-level)
└── hooks/
    └── block-sf-prod-deploy.sh     # the guard script
admin/
├── setup.sh                        # activate admin override
└── disable.sh                      # deactivate admin override
install.sh                          # install hook globally (all projects)
```

`.claude/settings.json` registers a `PreToolUse` matcher on `Bash`. Every Bash command Claude Code attempts is piped to the script as JSON on stdin. The script:

1. Reads `tool_input.command` from the JSON payload.
2. Returns `exit 0` immediately if the command is not a deploy.
3. Skips commands wrapped in `echo`, `printf`, or `cat` (documentation, not execution).
4. Checks the **admin override** — if the current user is an active member of `Kelley-Austin/prod-deploy-admins` and has a valid local override file, the deploy is allowed.
5. Parses `--target-org` / `--targetusername` / `-o` / `-u` from the command. Falls back to the default target org if unset.
6. Runs `sf org display --target-org <alias> --json` to resolve the org. **Denies** if it cannot.
7. Allows immediately if `isSandbox=true` or `isScratch=true`.
8. Allows immediately if the `instanceUrl` matches a reserved Salesforce subdomain pattern: `*.sandbox.my.salesforce.com`, `*.develop.my.salesforce.com`, `*.scratch.my.salesforce.com`, `*.pre.my.salesforce.com`, or `*prerellogin.pre.salesforce.com*`.
9. Otherwise queries `Organization` for `OrganizationType` and `TrialExpirationDate`.
10. Allows if `OrganizationType` is `Developer Edition`, `Partner Developer Edition`, or `Personal Edition`.
11. Allows if `TrialExpirationDate` is set (trial / pre-release / signup orgs).
12. **Denies** everything else (real Enterprise/Unlimited/Performance/Group/Professional/Base orgs with no trial).

Denials are emitted as:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "BLOCKED: deployment to a PRODUCTION org is forbidden. ..."
  }
}
```

Claude Code surfaces the reason to the model and the user, and the Bash call never runs.

### Commands the hook intercepts

- `sf project deploy start | validate | quick | cancel | report | resume | preview`
- `sf deploy ...` (any subcommand)
- `sfdx force:source:deploy`
- `sfdx force:mdapi:deploy`
- `sfdx force:source:push`

These patterns are matched even when the deploy command is chained behind `cd ... && ...`, an inline env-var prefix, or a subshell. Non-deploy `sf` commands (e.g. `sf org list`, `sf data query`) pass through untouched.

### Decision rule

Checks are evaluated top-to-bottom. The first matching row wins.

| Signal | Decision |
|---|---|
| User is active member of `Kelley-Austin/prod-deploy-admins` + local override file valid | **allow** (admin override) |
| `isSandbox = true` | allow |
| `isScratch = true` | allow |
| `instanceUrl` matches `*.sandbox.my.salesforce.com` | allow |
| `instanceUrl` matches `*.develop.my.salesforce.com` (Developer Edition) | allow |
| `instanceUrl` matches `*.scratch.my.salesforce.com` | allow |
| `instanceUrl` matches `*.pre.my.salesforce.com` or `prerellogin.pre.salesforce.com` (pre-release pods) | allow |
| `OrganizationType` ∈ { Developer Edition, Partner Developer Edition, Personal Edition } | allow |
| `TrialExpirationDate` is not null (trial / pre-release / signup) | allow |
| Anything else (real Enterprise / Unlimited / Performance / Group / Professional / Base edition) | **deny** |
| Org cannot be resolved or queried | **deny** (fail closed) |

---

## Installation

### For all employees (required)

Clone the repo and run the install script once per machine:

```bash
git clone https://github.com/Kelley-Austin/ka-vault.git ~/Documents/Perficient\ Projects/ka-vault
cd ~/Documents/Perficient\ Projects/ka-vault
bash install.sh
```

`install.sh` does three things:

1. Copies the hook script to `~/.local/share/ka-vault/hooks/` and registers it in `~/.claude/settings.json` so the guard is active for **every Claude Code session** on this machine.
2. Installs the `cheese-backup-then-modify` helper to `~/.local/bin/` (a separate, non-security utility — see `bin/cheese-backup-then-modify -h`).
3. Idempotently adds `"Bash(git *)"` to the `permissions.allow` array in `~/.claude/settings.json` so `git checkout`, `git merge`, `git status`, etc. don't trigger permission prompts in any Claude Code session. **This is independent of the prod-deploy block** — the hook intercepts `sf project deploy start|validate|quick|resume` regardless of what's in the allow list.

Restart any open Claude Code sessions afterward to pick up the changes.

> **This is mandatory.** Every developer must run `install.sh` before using Claude Code on any Salesforce project.

### Requirements

- Claude Code (any recent version that supports `PreToolUse` hooks)
- Salesforce CLI (`sf`) on `PATH`. If `sf` is installed but not on the hook's `PATH`, the script also probes:
  - `/opt/homebrew/bin/sf`
  - `/usr/local/bin/sf`
  - `~/.local/share/sf/bin/sf`
- `jq` on `PATH` (preinstalled on most macOS dev setups; otherwise `brew install jq`)
- `bash` (3.2+ — the macOS default works)

### Activating the hook in an existing session

Claude Code's settings watcher only picks up new `.claude/` entries when the session starts. If you installed mid-session:

- Restart Claude Code.

New sessions pick the hook up automatically after `install.sh` has been run.

---

## Admin override

Active members of the `Kelley-Austin/prod-deploy-admins` GitHub team can temporarily disable the guard on their own machine. The override is local, scoped to 24 hours, and automatically re-verified against GitHub at expiry.

### Activating the override

```bash
bash ~/Documents/Perficient\ Projects/ka-vault/admin/setup.sh
```

This verifies your GitHub team membership via `gh` and writes a timestamped override file to `~/.local/share/ka-vault/admin-override`. The next Claude Code deploy check reads the file, confirms the timestamp is under 24 hours old, and allows the deploy.

After 24 hours, the hook re-queries GitHub. If you are still in the team, it renews automatically. If you have been removed from the team, the override is revoked.

### Deactivating the override

```bash
bash ~/Documents/Perficient\ Projects/ka-vault/admin/disable.sh
```

Removes the override file immediately. The guard resumes for the next deploy attempt.

### Adding / removing admins

Admin access is controlled entirely through GitHub team membership — no code changes needed.

- **Grant access:** Add the user to `Kelley-Austin/prod-deploy-admins` on GitHub.
- **Revoke access:** Remove them from the team. Their override file will expire within 24 hours and fail re-verification.
- **Immediate revocation:** Remove from team + ask them to run `admin/disable.sh`. Their next deploy attempt will also detect the removal and revoke the local file.

---

## Usage

There is nothing to invoke. Once the hook is active:

```
> claude code: deploy this to my prod org
```

```
sf project deploy start --target-org PROD
```

The Bash call is intercepted before it executes. Claude Code receives a denial with a structured reason explaining that production deployments are forbidden, including the resolved alias, username, and instance URL for transparency.

To deploy to a sandbox or scratch org, use the alias as normal:

```
sf project deploy start --target-org dev-sandbox -d force-app
```

The hook resolves `dev-sandbox`, sees `isSandbox=true`, and allows it.

---

## Verifying the hook locally

You can pipe-test the script directly without going through Claude Code:

```bash
# non-deploy command (expect: empty stdout, exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"sf org list"}}' \
  | .claude/hooks/block-sf-prod-deploy.sh

# documentation in echo (expect: pass-through)
echo '{"tool_name":"Bash","tool_input":{"command":"echo sf project deploy start"}}' \
  | .claude/hooks/block-sf-prod-deploy.sh

# real deploy with bogus alias (expect: BLOCK JSON, exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"sf project deploy start --target-org NOPE -d force-app"}}' \
  | .claude/hooks/block-sf-prod-deploy.sh
```

The script always exits `0` — denial is communicated via the JSON body, per the Claude Code hook contract.

---

## Repository layout

```
ka-vault/
├── .claude/
│   ├── settings.json                # registers the PreToolUse Bash hook (project-level)
│   └── hooks/
│       └── block-sf-prod-deploy.sh  # guard script (fail-closed)
├── admin/
│   ├── setup.sh                     # activate admin override (team members only)
│   └── disable.sh                   # deactivate admin override
├── install.sh                       # install hook globally into ~/.claude/settings.json
└── README.md
```

`.claude/settings.json` is checked in so every contributor working in this repo gets the protection automatically. There is no `.claude/settings.local.json`; this guard is intentionally not user-overridable at the project level.

The globally-installed copy (written by `install.sh`) lives at `~/.local/share/ka-vault/hooks/block-sf-prod-deploy.sh` and is registered in `~/.claude/settings.json`. It is functionally identical to the project-level copy.

---

## Design notes

- **Fail closed.** If `sf org display` errors, returns nothing, or returns malformed JSON, the deploy is denied. Better to block a legitimate sandbox push than allow a single accidental prod write.
- **Target resolution.** The script honors explicit `--target-org` first, then falls back to whatever `sf` considers the current default — same resolution order as the deploy command itself, so the org being checked is the org that would be deployed to.
- **No wrapper bypass.** Wrapping a deploy in a subshell, `cd && ...`, or a `VAR=foo sf ...` prefix does not evade the matcher. Hiding it inside `echo`, `printf`, or `cat` is not bypass either — those commands don't execute the deploy, so they're allowed.
- **Decoupled from validate vs. start.** All `sf project deploy` subcommands are gated, including `validate` and `quick`. `validate` against production consumes a deployment slot, and `quick` will actually deploy a previously-validated package. Both are blocked when the target is production.
- **Admin override is GitHub-authoritative.** The bypass check is verified against the GitHub API, not a local secret. Removing someone from the `prod-deploy-admins` team on GitHub is the single revocation action; no hook code needs to change.
- **Admin override is machine-local.** The override file at `~/.local/share/ka-vault/admin-override` does not exist in the repo and has no effect on other users' machines.
- **No exceptions for non-admins.** The hook does not honor an env-var override, a magic flag, or a comment marker for regular users. If a non-admin needs to deploy to production, they must do it from a standard terminal outside Claude Code.

---

## Troubleshooting

**The hook didn't fire.** Restart Claude Code — it reads `~/.claude/settings.json` at session start. If the global settings were updated while the session was already open, the hook won't load until restart.

**It blocks everything, even sandbox deploys.** Confirm `sf` is on the hook shell's `PATH` and `sf org display --target-org <your-alias> --json` succeeds in your terminal. If `sf org display` returns `DomainNotFoundError`, the auth file is stale — re-authenticate with `sf org login web --instance-url <url>` and retry. The hook recognizes sandboxes by URL pattern even when stale auth lies about `isSandbox`, but it cannot recognize anything if the org won't resolve at all.

**It blocked a deploy whose target org I haven't authenticated yet.** That's correct fail-closed behavior. Authenticate the org first with `sf org login web`, then retry.

**Admin override isn't working.** Confirm `gh auth status` succeeds and that you are an active (not pending) member of `Kelley-Austin/prod-deploy-admins`. Run `admin/setup.sh` again to refresh the cache.

**I want it disabled (non-admin).** Don't disable it. If you need to deploy to production, use a standard terminal session outside Claude Code.
