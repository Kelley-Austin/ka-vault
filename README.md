# ka-vault

Claude Code project hook that **blocks Salesforce deployments to production orgs**. No exceptions.

When this hook is active, Claude Code cannot run `sf project deploy`, `sf deploy`, or any legacy `sfdx force:source:deploy` / `force:mdapi:deploy` / `force:source:push` command against an org that is not a sandbox or scratch org. The hook fails closed: if the target org cannot be resolved, the deploy is denied.

---

## Why

Production deployments must be deliberate human actions performed from a CI pipeline or an explicitly-supervised terminal session. They must not be triggered by an LLM agent, even an instructed one. This repo enforces that as a hard pre-tool gate, so the protection is mechanical rather than dependent on prompting.

---

## How it works

Claude Code supports `PreToolUse` hooks that run before a tool is executed. A hook can return JSON that denies permission to run the tool. This project ships:

```
.claude/
├── settings.json                   # registers the hook
└── hooks/
    └── block-sf-prod-deploy.sh     # the guard script
```

`.claude/settings.json` registers a `PreToolUse` matcher on `Bash`. Every Bash command Claude Code attempts is piped to the script as JSON on stdin. The script:

1. Reads `tool_input.command` from the JSON payload.
2. Returns `exit 0` immediately if the command is not a deploy.
3. Skips commands wrapped in `echo`, `printf`, or `cat` (documentation, not execution).
4. Parses `--target-org` / `--targetusername` / `-o` / `-u` from the command. Falls back to the default target org if unset.
5. Runs `sf org display --target-org <alias> --json` to resolve the org.
6. Reads `result.isSandbox` and `result.isScratch` from the response.
7. **Denies** the tool call if `isSandbox=false` AND `isScratch=false`.
8. **Denies** the tool call if `sf org display` cannot resolve the org at all.
9. Otherwise allows it.

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

| `isSandbox` | `isScratch` | Decision |
|-------------|-------------|----------|
| `true`      | any         | allow    |
| any         | `true`      | allow    |
| `false`     | `false`     | **deny** |
| unknown     | unknown     | **deny** (fail closed) |

---

## Installation

Clone or copy this repo onto your workstation:

```bash
git clone https://github.com/Kelley-Austin/ka-vault.git
```

The hook activates automatically when Claude Code is launched with this directory as the project root, because Claude Code reads `.claude/settings.json` on session start.

### Requirements

- Claude Code (any recent version that supports `PreToolUse` hooks)
- Salesforce CLI (`sf`) on `PATH`. If `sf` is installed but not on the hook's `PATH`, the script also probes:
  - `/opt/homebrew/bin/sf`
  - `/usr/local/bin/sf`
  - `~/.local/share/sf/bin/sf`
- `jq` on `PATH` (preinstalled on most macOS dev setups; otherwise `brew install jq`)
- `bash` (3.2+ — the macOS default works)

### Activating the hook in an existing session

Claude Code's settings watcher only picks up `.claude/` directories that existed when the session started. If you added this repo mid-session:

- Open `/hooks` once (reloads config), **or**
- Restart Claude Code.

New sessions started inside this directory pick the hook up automatically.

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
│   ├── settings.json                # registers the PreToolUse Bash hook
│   └── hooks/
│       └── block-sf-prod-deploy.sh  # guard script (fail-closed)
└── README.md
```

`.claude/settings.json` is checked in so every contributor working in this repo gets the protection automatically. There is no `.claude/settings.local.json`; this guard is intentionally not user-overridable at the project level.

---

## Design notes

- **Fail closed.** If `sf org display` errors, returns nothing, or returns malformed JSON, the deploy is denied. Better to block a legitimate sandbox push than allow a single accidental prod write.
- **Target resolution.** The script honors explicit `--target-org` first, then falls back to whatever `sf` considers the current default — same resolution order as the deploy command itself, so the org being checked is the org that would be deployed to.
- **No wrapper bypass.** Wrapping a deploy in a subshell, `cd && ...`, or a `VAR=foo sf ...` prefix does not evade the matcher. Hiding it inside `echo`, `printf`, or `cat` is not bypass either — those commands don't execute the deploy, so they're allowed.
- **Decoupled from validate vs. start.** All `sf project deploy` subcommands are gated, including `validate` and `quick`. `validate` against production consumes a deployment slot, and `quick` will actually deploy a previously-validated package. Both are blocked when the target is production.
- **No exceptions.** The hook does not honor an env-var override, a magic flag, or a comment marker. If you need to deploy to production, do it from CI or an out-of-band terminal session, not from Claude Code.

---

## Troubleshooting

**The hook didn't fire.** Open `/hooks` in Claude Code or restart. The settings watcher only tracks `.claude/` directories that existed at session start.

**It blocks everything, even sandbox deploys.** Confirm `sf` is on the hook shell's `PATH` and `sf org display --target-org <your-alias> --json` succeeds in your terminal. If `sf org display` returns `isSandbox: false` for what you believe is a sandbox, your alias is wrong — verify with `sf org list`.

**It blocked a deploy whose target org I haven't authenticated yet.** That's correct fail-closed behavior. Authenticate the org first with `sf org login web`, then retry.

**I want it disabled.** Don't disable it. If you're certain you need to bypass it for a legitimate reason, run the deploy from a shell outside Claude Code.
