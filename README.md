# ka-vault

A Claude Code plugin, `sf-prod-guard`, that **blocks every Salesforce CLI command that can change a production org**. There are no exceptions and no override.

The guard allows writes to these orgs:

- sandboxes
- scratch orgs
- Developer Edition orgs
- trial orgs
- demo orgs (IDO, SDO) that are in the allowlist

The guard fails closed. If it cannot prove that the target org is not production, it blocks the command.

---

## Why

A person must start every production deployment on purpose, from a CI pipeline or from a terminal outside Claude Code. An AI agent must never start one, even when someone tells it to. This repo enforces that rule mechanically, before the command runs, so the protection does not depend on prompts.

---

## How it works

Claude Code runs a `PreToolUse` hook before each Bash command. The hook gets the command as JSON on stdin. It allows the command with exit code `0`, or blocks it with exit code `2`. When it blocks, Claude Code shows the reason (stderr) to the model.

```
.claude-plugin/marketplace.json     # this repo is a plugin marketplace named "ka-vault"
plugins/sf-prod-guard/
├── .claude-plugin/plugin.json      # plugin manifest
├── hooks/hooks.json                # PreToolUse hook for Bash: timeout 60 s, onFailure "block"
└── guard/
    ├── block-sf-prod-deploy.sh     # hook entry: finds Node.js, changes every failure into exit 2
    ├── sf-prod-guard.mjs           # Node entry point
    ├── guard-lib.mjs               # shell parser, command classification, org check
    ├── sf-command-table.json       # every sf command and whether it takes --target-org (generated)
    ├── gen-sf-command-table.mjs    # makes sf-command-table.json again from the installed CLI
    └── allowed-orgs.json           # Org ID allowlist for demo orgs (IDO/SDO)
managed/managed-settings.json       # example policy that makes the plugin mandatory
tests/guard.test.mjs                # end-to-end tests with a fake sf (no org access)
install.sh                          # installs the plugin and removes the old hook
```

### Step 1: Parse the command as shell syntax

The guard does not search the command text with a regex. It parses the command the way a shell does:

- quotes, `\` escapes, `$'...'`, and line continuations
- comments
- heredocs (data), and `$(...)` inside an unquoted heredoc (runs)
- `$(...)`, backticks, `<(...)`, and subshells
- `&&`, `||`, `;`, `|`, and new lines

It then finds each `sf` or `sfdx` call, also behind wrappers: `env`, `sudo`, `time`, `timeout`, `xargs`, `command`, `exec`, `script`, `find -exec`, `npx @salesforce/cli`, `npm exec`, `node .../@salesforce/cli/bin/run.js`, `bash -c`, `sh -c`, `eval`, and `watch`. It also checks the parts of `awk` (`system()`, `getline`, pipes), GNU `sed` (the `e` command), and `git -c` that can run commands. It also finds `sf` when the command name is written as a path (`/opt/homebrew/bin/sf`), with quotes or escapes (`"sf"`, `s\f`), as a zsh `=sf`, as a brace expansion (`{sf,}`), or as a glob (`s[f]`). A `-u`/`--targetusername` alias of `--target-org` counts as a target. The command table records these aliases for each command.

Text in a commit message, a PR body, an `echo`, a `grep`/`rg` pattern, or a quoted heredoc is data. It does not cause a block.

### Step 2: Classify each sf command

`sf-command-table.json` lists all sf commands (with aliases, for example `deploy metadata` → `project deploy start`). For each command it records whether it takes `--target-org` or `--target-dev-hub`, whether it takes positional arguments, and every flag spelling with its arity (boolean or value). The guard uses the arity to parse arguments the way sf (oclif) does. So `-rw5` is read as `-r -w 5`, and in `--stream-to-file --target-org=x` the second word is a file name, not an org flag. A word after a known command id that the command cannot take as an argument (for example `sf org list purge`) makes the command unknown. sf also accepts command words in another order (`sf delete org sandbox` = `sf org delete sandbox`), and the guard resolves that order too. If the table cannot load, the guard blocks every sf command.

| Command kind | Examples | Decision |
|---|---|---|
| Help | `--help`, `-h` | allow |
| Local, or Dev Hub scratch org and beta package work (no `--target-org`) | `org list`, `config get`, `org create scratch -v hub`, `package version create`, `project deploy resume`, `project deploy report` | allow |
| Read-only org commands | `data query`, `project retrieve start`, `org display`, `project deploy preview`, `sobject describe` | allow |
| Dev Hub changes that cannot be undone or that affect subscribers | `package version promote`, `package delete`, `package version delete`, `package update`, `package version update`, `package push-upgrade abort` | **check the Dev Hub org** (needs `--target-dev-hub`) |
| Destination org cannot be verified | `project deploy pipeline start/quick/validate`, `devops promote`, `devops promotion complete/validate`, `package push-upgrade schedule`, `org delete sandbox` (deletes through the production parent) | **block** |
| All other org commands | `project deploy start/validate/quick/cancel`, `api request rest` (any method: a GET to `/tooling/executeAnonymous` runs Apex), `project delete source`, `apex run`, `apex run test`, `data create/update/delete/upsert/import`, `package install`, `org assign permset`, `org create user`, `org create sandbox` | **check the org** (step 3) |
| Unknown commands (other plugins, newer CLI) | `sf sfdmu run ...`, `sf hardis ...` | **check the org** (step 3) |

### Step 3: Require an explicit target

A command that is checked must name its org with `--target-org <alias>` (or `-o`). Hidden aliases of that flag, such as `-u` and `--targetusername`, also count. The command table records them for each command. The guard does **not** use the default org, `SF_TARGET_ORG`, or `sf config`. These values depend on the folder and the environment, so the guard cannot read them reliably.

`sf project deploy quick` and `sf project deploy cancel` use the org saved with the job in `~/.sf/deploy-cache.json` before they use `--target-org`. The guard checks that cached org too. Another deploy command in the same Bash call (for example `deploy resume`) can change that cache, so the guard blocks quick or cancel together with another deploy command. Run them as separate Bash commands. It reads short-flag clusters the way sf does (`-rw` = `-r -w`).

The guard also blocks these cases:

- The target value is a shell expansion (`-o "$ORG"`). Write the literal alias.
- The command has two different targets.
- A short-flag cluster hides the org flag (`-gu prod`). Write each flag separately.
- The command uses `--flags-dir`, which can change the target.
- The same Bash call changes an alias, login, or sf config (`sf alias set`, `sf org login ...`, `sf config set`) and also runs a checked command. The guard resolves the alias *before* the command runs, so the alias must not change in the same call.
- The same Bash call sets `HOME`, `XDG_*`, or `SF_*`/`SFDX_*` variables (except harmless ones, such as `SF_LOG_LEVEL`).
- The command name contains a shell expansion (`$C ...`, `eval "$C"`, `s${X:-f}`) in a command that can be a Salesforce command.
- Inline code (`python3 -c`, `node -e`, `perl -e`, `osascript -e`, and similar) or an `ssh` remote command mentions Salesforce. The guard cannot check code in another language or on another machine.
- `xargs` or `parallel` adds arguments to an `sf` command from its input, so the guard cannot see the full command. A complete read-only command (for example `xargs sf data query -q ... -o x`) is allowed.
- `sudo`, `doas`, or `su` runs a checked `sf` command as another user. That user has other org logins.
- A shell reads a script from a pipe (`... | bash`) and the command mentions Salesforce. A heredoc or here-string script (`bash <<EOF`) is parsed and checked like any other command.

### Step 4: Check the org with live data

For each target, the guard runs:

```
sf data query --query "SELECT Id, Name, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization" --target-org <alias> --json
```

| Live `Organization` data | Decision |
|---|---|
| `Id` is in `plugins/sf-prod-guard/guard/allowed-orgs.json` and the entry has not expired | allow (demo org) |
| `IsSandbox = true` | allow |
| `OrganizationType` is `Developer Edition` or `Partner Developer Edition` | allow |
| `TrialExpirationDate` is set (trials, scratch orgs, demo orgs that expire) | allow |
| Anything else: Enterprise, Unlimited, Performance, Professional, Personal, Team, Base edition with no trial date | **block** |
| The query fails, returns no record, or takes too long | **block** |

The guard does not use the cached `isSandbox`/`isScratch` values from `sf org display`, or patterns in the instance URL. The live query is the only source.

---

## Demo orgs (IDO, SDO)

Many IDOs and SDOs report `Enterprise Edition` or `Unlimited Edition` with no `TrialExpirationDate`. From live data alone, they look the same as a client's production org. To allow one, add its **Org ID** to `plugins/sf-prod-guard/guard/allowed-orgs.json` by pull request:

1. Get the Org ID: `sf data query -q "SELECT Id, Name, OrganizationType, TrialExpirationDate FROM Organization" -o <demo-alias>`
2. Add an entry:

   ```json
   {
     "orgs": [
       { "orgId": "00D5g000000XXXXEAA", "label": "Axios IDO", "kind": "IDO", "owner": "marc.swan", "expires": "2027-03-31" }
     ]
   }
   ```

3. Open a PR. After it merges, the change reaches each developer with the next plugin update (see [Updates](#updates)).

Rules:

- Use the Org ID, never an alias. Anyone can rename an alias on their own machine. An Org ID is the same everywhere and never changes.
- Set `expires` to a real date in `YYYY-MM-DD` format. The guard ignores an entry with no valid `expires` date, and an entry after that date.
- Never add a client's production org.

---

## Installation

The guard is a Claude Code plugin. This repo is its marketplace. Clone the repo and run the installer once on each machine:

```bash
git clone https://github.com/Kelley-Austin/ka-vault.git ~/Documents/Perficient\ Projects/ka-vault
cd ~/Documents/Perficient\ Projects/ka-vault
bash install.sh
```

`install.sh` does these steps:

1. Stops with an error if `disableAllHooks` is `true` in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json` when that variable is set).
2. Adds the `ka-vault` marketplace (`Kelley-Austin/ka-vault` on GitHub) and installs `sf-prod-guard@ka-vault` for your user. If the plugin is already installed, it updates it. It enables the plugin if it is turned off.
3. Runs a self-test with the installed hook. A deploy with no target must give exit 2, and `git status` must give exit 0. If the test fails, the script stops before step 4.
4. Removes the hook registration and the files of older ka-vault versions (`~/.local/share/ka-vault/`). Without this step, the guard would run twice.
5. Installs the `cheese-backup-then-modify` helper to `~/.local/bin/`.
6. Adds `"Bash(git *)"` to `permissions.allow` in `~/.claude/settings.json`.

Restart open Claude Code sessions after you install.

To install without the script, run these two commands in a terminal, or the same commands with `/plugin` inside Claude Code:

```bash
claude plugin marketplace add Kelley-Austin/ka-vault
claude plugin install sf-prod-guard@ka-vault
```

If you used an older version of ka-vault, also run `install.sh` once, or remove the `block-sf-prod-deploy` entry from `~/.claude/settings.json` yourself.

> **This is mandatory.** Every developer must install the plugin before using Claude Code on any Salesforce project.

### In this repo

`.claude/settings.json` adds the `ka-vault` marketplace and enables `sf-prod-guard@ka-vault` for this project. Claude Code applies these settings after you trust the folder. A teammate who opens this repo gets the guard in this project even before they run `install.sh`. Only the user install (or managed settings) protects their other projects.

### Updates

`plugin.json` has no `version` field on purpose. Claude Code then uses the commit SHA as the version, so each commit merged to `main` is a new plugin version. Do not add a `version` field: with one, users stay on that version until someone changes it, and a guard fix would not reach them.

To get the newest guard now:

```bash
claude plugin marketplace update ka-vault && claude plugin update sf-prod-guard@ka-vault
```

Or run `bash install.sh` again. Restart Claude Code after an update.

The machine needs read access to the `Kelley-Austin/ka-vault` GitHub repo to add the marketplace and to get updates.

### Managed settings (make the guard mandatory)

A developer can turn a plugin off with `/plugin` or `claude plugin disable`. To make the guard mandatory on company machines, an admin deploys managed settings. [`managed/managed-settings.json`](managed/managed-settings.json) is a ready policy:

```json
{
  "extraKnownMarketplaces": {
    "ka-vault": { "source": { "source": "github", "repo": "Kelley-Austin/ka-vault" }, "autoUpdate": true }
  },
  "enabledPlugins": { "sf-prod-guard@ka-vault": true }
}
```

A plugin that managed settings enable stays on. A user cannot turn it off in their own settings. Deploy the policy one of these ways:

| Method | Where |
| --- | --- |
| File | macOS `/Library/Application Support/ClaudeCode/managed-settings.json`, Linux and WSL `/etc/claude-code/managed-settings.json`, Windows `C:\Program Files\ClaudeCode\managed-settings.json`. A file in `managed-settings.d/` next to it also works. |
| MDM | macOS profile for the `com.anthropic.claudecode` domain. Windows registry value `Settings` under `HKLM\SOFTWARE\Policies\ClaudeCode`. |
| Server-managed (Claude for Teams and Enterprise) | claude.ai, Organization settings > Claude Code > Managed settings. An Owner sets the JSON. |

By default, only one managed source applies on a machine: server-managed first, then MDM, then the file. If you already use one of them for other policy, add these keys to it.

Optional, stricter keys (they affect every developer's other plugins and hooks, so agree on them first):

- `"allowManagedHooksOnly": true` runs only managed hooks and hooks of plugins that managed settings enable. The guard still runs. Hooks from other plugins and from user or project settings stop.
- `strictKnownMarketplaces` allows plugins only from listed marketplaces.

See the Claude Code docs: [managed settings](https://code.claude.com/docs/en/managed-settings) and [plugins for organizations](https://code.claude.com/docs/en/plugins/org).

### Requirements

- Claude Code with plugin support. Version 2.1.295 or later is recommended: earlier versions ignore `onFailure`, so a guard crash or timeout does not block there.
- Node.js 18 or later. The `sf` CLI needs it too. The hook looks on `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, Volta, the sf installer folders, nvm, and the folder of the `sf` binary. If it finds no Node.js, it blocks every Bash command that mentions `sf` or Salesforce, uses ANSI-C quoting (`$'...'`), or has an expansion where a command name can be. This fallback is a simple text check, not a parser. Install Node.js to get the full guard.
- The Salesforce CLI (`sf`). The hook looks on `PATH`, then in the usual install folders and nvm.
- `jq` and the `claude` CLI, for `install.sh` only. The hook does not need `jq`.

---

## Known limits

A hook only sees the text of the Bash command that Claude Code is about to run. These cases are outside its view:

- **Scripts.** `bash deploy.sh`, `npm run deploy`, `make deploy`, and similar commands run code that the guard cannot see. Do not put production deploys in scripts in a Claude Code workspace.
- **Shell aliases and functions.** Claude Code's Bash tool loads your shell profile. An alias or function there (for example `alias dp='sf project deploy start'`) hides `sf` from the guard. Do not define aliases or functions that wrap `sf` deploy or write commands.
- **Other tools.** A Salesforce MCP server, or `curl` with an access token, does not go through `sf` in a Bash command. Do not connect a Salesforce MCP server to a production org in Claude Code.
- **Hook timeout.** The guard kills a slow org query (the whole process group) and blocks after about 40 seconds. A Node watchdog blocks at 45 seconds. The wrapper starts Node under a 50-second `perl` alarm, which also stops Node when it is busy in synchronous code. Claude Code's limit for the hook is 60 seconds. The hook sets `"onFailure": "block"`, so if Claude Code stops the hook, or the hook ends with an exit code other than 0 or 2, Claude Code blocks the command. Claude Code versions before 2.1.295 do not support `onFailure`. There, a stopped hook does not block.
- **`bash -n`.** The guard skips `bash -n -c '...'` (syntax check only). It does not skip other shell options that prevent execution.

The strongest control is credentials: do not authenticate production orgs on a machine where Claude Code runs Salesforce work.

---

## Policy decisions in this version

- **No admin override.** The old 24-hour override let any deploy through, which broke the "never production" rule. Admins deploy to production through CI or from a terminal outside Claude Code.
- **`project deploy validate` and `--dry-run` against production are blocked.** They do not save metadata. But they run tests in production, and a validated job lets `deploy quick` deploy it.
- **Personal Edition is blocked.** It is a paid production edition, not a development org.
- **Dev Hub packaging changes that cannot be undone are checked.** `package version promote`, `package delete`, `package version delete`, `package update`, `package version update`, and `package push-upgrade abort` check the Dev Hub org. A production Dev Hub blocks them.
- **Scratch org, package create, and beta package version commands are allowed on a production Dev Hub.** They write records in the Dev Hub (`ScratchOrgInfo`, `Package2`, beta `Package2Version`). Dev Hubs are almost always production orgs, so blocking these commands would block all scratch org development. Decide as a team if `package create` and `package convert` must also be checked.
- **`org delete sandbox` is blocked.** sf deletes the sandbox through its production parent org.
- **`project deploy cancel` against production is blocked.** A cancel changes an active production deployment.
- **`apex run test` and `apex tail log` against production are blocked.** Tests run code in production, and `apex tail log` creates trace flags.
- **Sandbox create/refresh/delete against a production org is blocked.** These commands write to the production org.

---

## Testing

```bash
node --test tests/*.test.mjs
```

The tests run the real hook wrapper with a fake `sf`. They do not contact an org. They cover every bypass and false positive found in review, the fail-closed paths, and every allowed org type.

Test the hook by hand (from the repo root):

```bash
# blocked: no explicit target
echo '{"tool_input":{"command":"sf project deploy start"}}' | bash plugins/sf-prod-guard/guard/block-sf-prod-deploy.sh; echo "exit $?"

# allowed: text in a commit message
echo '{"tool_input":{"command":"git commit -m \"sf project deploy start -o prod\""}}' | bash plugins/sf-prod-guard/guard/block-sf-prod-deploy.sh; echo "exit $?"
```

After a Salesforce CLI upgrade, or after you install an sf plugin, make the command table again:

```bash
node plugins/sf-prod-guard/guard/gen-sf-command-table.mjs && node --test tests/*.test.mjs
```

A command that is not in the table is treated as a write, so an old table usually causes a false block, not a missed write. One exception: a new subcommand under an existing command that takes positional arguments (for example `sf config get <new-word>`) is read as that existing command. Make the table again after each sf upgrade or plugin install.

---

## Troubleshooting

**The hook did not fire.** Run `claude plugin list` and make sure that `sf-prod-guard@ka-vault` is enabled. Then restart Claude Code. It loads plugins and hooks when the session starts.

**It blocks a deploy to my sandbox.** Read the reason in the message.

- "Add an explicit --target-org": add `-o <alias>` to the command.
- "Cannot confirm that org ... is not production": run `sf org list` and `sf data query -q "SELECT IsSandbox FROM Organization" -o <alias>` in a terminal. If the login has expired, run `sf org login web -a <alias> -r https://test.salesforce.com`.
- "is a PRODUCTION org" for a demo org: add its Org ID to `plugins/sf-prod-guard/guard/allowed-orgs.json` (see [Demo orgs](#demo-orgs-ido-sdo)).

**It blocks a command that only reads.** Run `node plugins/sf-prod-guard/guard/gen-sf-command-table.mjs`. If the command is still blocked, open an issue so the team can add it to the read-only list in `plugins/sf-prod-guard/guard/guard-lib.mjs`.

**I need to deploy to production.** Use CI, or a terminal outside Claude Code.
