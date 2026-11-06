# ka-vault

ka-vault contains **`sf-prod-guard`**, the Kelley Austin Claude Code plugin that **blocks every Salesforce CLI command that can change a production org**. There are no exceptions and no override.

The guard allows writes to these orgs:

- sandboxes
- scratch orgs
- Developer Edition orgs
- trial orgs
- demo orgs (IDO, SDO) that are in the allowlist

The guard fails closed. If it cannot prove that the target org is not production, it blocks the command.

## Contents

- [Why](#why)
- [Install](#install)
  - [Before you start](#before-you-start)
  - [Option A: install script (recommended)](#option-a-install-script-recommended)
  - [Option B: install from Claude Code](#option-b-install-from-claude-code)
  - [Option C: make the guard mandatory (admins)](#option-c-make-the-guard-mandatory-admins)
  - [Verify the install](#verify-the-install)
  - [Update](#update)
  - [Move from an older ka-vault version](#move-from-an-older-ka-vault-version)
  - [Uninstall](#uninstall)
- [Daily use](#daily-use)
- [What the guard allows and blocks](#what-the-guard-allows-and-blocks)
- [How it works](#how-it-works)
- [Demo orgs (IDO, SDO)](#demo-orgs-ido-sdo)
- [Repository layout](#repository-layout)
- [Configuration reference](#configuration-reference)
- [Known limits](#known-limits)
- [Policy decisions](#policy-decisions)
- [Development](#development)
- [Troubleshooting](#troubleshooting)

---

## Why

A person must start every production deployment on purpose, from a CI pipeline or from a terminal outside Claude Code. An AI agent must never start one, even when someone tells it to. The guard enforces this rule mechanically, before the command runs. The protection does not depend on prompts or on instructions in `CLAUDE.md`.

---

## Install

Install the guard once on each machine where you use Claude Code. The guard then applies to every Claude Code session on that machine, in every project.

> **This is mandatory.** Every developer must install the guard before they use Claude Code on a Salesforce project.

### Before you start

Make sure that these tools are installed. To verify each tool, run its command in a terminal.

| Tool | Command | You need |
| --- | --- | --- |
| Claude Code | `claude --version` | 2.1.295 or later. Earlier versions run the guard, but a guard crash or timeout does not block there. To update: `claude update`. |
| Node.js | `node --version` | v18 or later. The `sf` CLI needs it too. |
| Salesforce CLI | `sf --version` | Any current version. |
| git | `git --version` | Any version. Needed to clone this repo. |
| jq | `jq --version` | Any version. Only `install.sh` needs it. To install on macOS: `brew install jq`. |

The repo is public on GitHub. You do not need special access to install the plugin or to get updates.

### Option A: install script (recommended)

Use this option on a new machine, and on a machine that had an older version of ka-vault.

1. Open a terminal.
2. Clone the repo and go into it:

   ```bash
   git clone https://github.com/Kelley-Austin/ka-vault.git
   cd ka-vault
   ```

3. Run the installer:

   ```bash
   bash install.sh
   ```

   When it succeeds, the output includes these lines:

   ```
   ✓ sf-prod-guard@ka-vault is installed and enabled (...)
   ✓ Automatic updates are on for the ka-vault marketplace
   ✓ Self-test passed (a deploy with no --target-org is blocked; git status is allowed)
   ka-vault is installed. The production guard is active for every Claude Code
   session on this machine. Restart open Claude Code sessions to load it.
   ```

   If the script stops with `Error:`, read the message, fix the cause, and run it again. See [Troubleshooting](#troubleshooting).

4. Quit every open Claude Code session, then start Claude Code again. Claude Code loads plugins only when a session starts.
5. [Verify the install](#verify-the-install).

`install.sh` does these steps:

1. Stops with an error if `disableAllHooks` is `true` in your Claude Code user settings. Disabled hooks never run.
2. Adds the `ka-vault` plugin marketplace (this GitHub repo) and installs `sf-prod-guard@ka-vault` for your user. If the plugin is already installed, it updates it. If the plugin is turned off, it turns it on.
3. Turns on automatic updates for the `ka-vault` marketplace.
4. Runs a self-test with the installed hook. A deploy with no target must give exit code 2 (block), and `git status` must give exit code 0 (allow). If the test fails, the script stops before step 5.
5. Removes the hook registration and the files of older ka-vault versions (`~/.local/share/ka-vault/`). Without this step, the guard runs twice.
6. Adds `"Bash(git *)"` to `permissions.allow` in your user settings, so git commands do not ask for permission.

You can run `install.sh` again at any time. It does not add duplicates.

### Option B: install from Claude Code

Use this option only on a machine that never had an older ka-vault version. This option does not remove an old hook registration and does not turn on automatic updates.

1. In Claude Code, run these two commands:

   ```
   /plugin marketplace add Kelley-Austin/ka-vault
   /plugin install sf-prod-guard@ka-vault
   ```

   The same commands work in a terminal: `claude plugin marketplace add Kelley-Austin/ka-vault`, then `claude plugin install sf-prod-guard@ka-vault`.

2. Quit and start Claude Code again.
3. [Verify the install](#verify-the-install).

### Option C: make the guard mandatory (admins)

A developer can turn a plugin off with `/plugin` or `claude plugin disable`. To prevent that on company machines, an admin deploys managed settings. Managed settings take precedence over all other settings. A user cannot turn off a plugin that managed settings enable.

[`managed/managed-settings.json`](managed/managed-settings.json) is a ready policy:

```json
{
  "extraKnownMarketplaces": {
    "ka-vault": {
      "source": { "source": "github", "repo": "Kelley-Austin/ka-vault" },
      "autoUpdate": true
    }
  },
  "enabledPlugins": { "sf-prod-guard@ka-vault": true }
}
```

Deploy it in one of these ways:

| Method | Where |
| --- | --- |
| File | macOS: `/Library/Application Support/ClaudeCode/managed-settings.json`. Linux and WSL: `/etc/claude-code/managed-settings.json`. Windows: `C:\Program Files\ClaudeCode\managed-settings.json`. A file in a `managed-settings.d/` folder next to it also works. |
| MDM | macOS: a configuration profile for the `com.anthropic.claudecode` domain. Windows: the registry value `Settings` under `HKLM\SOFTWARE\Policies\ClaudeCode`. |
| Server-managed (Claude for Teams and Enterprise) | claude.ai > Organization settings > Claude Code > Managed settings. An Owner sets the JSON. |

By default, only one managed source applies on a machine: server-managed first, then MDM, then the file. If you already use one of them for other policy, add these keys to that source.

Two stricter keys are available. They also affect every developer's other plugins and hooks, so agree on them as a team first:

- `"allowManagedHooksOnly": true` runs only managed hooks and the hooks of plugins that managed settings enable. The guard still runs. Hooks from other plugins and from user or project settings stop.
- `strictKnownMarketplaces` allows plugins only from the marketplaces in its list.

Developers still run `install.sh` once to remove the old hook registration.

See the Claude Code docs: [managed settings](https://code.claude.com/docs/en/managed-settings) and [plugins for organizations](https://code.claude.com/docs/en/plugins/org).

### Verify the install

1. In a terminal, run:

   ```bash
   claude plugin list
   ```

   The output must include:

   ```
   ❯ sf-prod-guard@ka-vault
     ...
     Status: ✔ enabled
   ```

2. Run the installed hook by hand. A deploy with no target must give `exit 2`, and `git status` must give `exit 0`:

   ```bash
   HOOK="$(claude plugin list --json | jq -r '.[] | select(.id == "sf-prod-guard@ka-vault") | .installPath')/guard/block-sf-prod-deploy.sh"
   echo '{"tool_input":{"command":"sf project deploy start"}}' | bash "$HOOK"; echo "exit $?"
   echo '{"tool_input":{"command":"git status"}}' | bash "$HOOK"; echo "exit $?"
   ```

3. In a new Claude Code session, ask Claude to run `sf project deploy start --dry-run`. Claude Code must block the command and show a message that starts with `ka-vault guard: BLOCKED.`

### Update

Each commit merged to `main` is a new plugin version. When automatic updates are on (Option A or C), Claude Code gets the new version when it starts. Restart Claude Code to load it.

To update now:

```bash
claude plugin marketplace update ka-vault && claude plugin update sf-prod-guard@ka-vault
```

Or run `bash install.sh` again. Then restart Claude Code.

### Move from an older ka-vault version

Older versions of ka-vault installed the guard as a hook in `~/.claude/settings.json`, with files in `~/.local/share/ka-vault/hooks/`. To move to the plugin:

1. Go to your ka-vault folder and get the newest version: `git pull`.
2. Run `bash install.sh`. It installs the plugin, tests it, and only then removes the old registration and files.
3. Quit and start Claude Code again.

If you install with Option B instead, remove the `block-sf-prod-deploy` entry from `hooks.PreToolUse` in `~/.claude/settings.json` yourself. Otherwise the guard runs twice.

### Uninstall

Do not uninstall the guard on a machine where you use Claude Code for Salesforce work. If you must remove it:

```bash
claude plugin uninstall sf-prod-guard@ka-vault
claude plugin marketplace remove ka-vault
```

If managed settings enable the plugin, an admin must change the managed settings.

---

## Daily use

The guard is silent for almost all commands. It acts only on Salesforce CLI commands that can change an org. Follow these rules, and the guard stays out of your way:

- **Always name the org.** Add `--target-org <alias>` (or `-o <alias>`) to every command that changes an org. The guard does not use your default org.

  ```bash
  sf project deploy start --source-dir force-app -o clare-uat
  ```

- **Write the alias literally.** Do not use a variable such as `-o "$ORG"`.
- **Log in and set aliases in a separate command.** Run `sf org login web -a clare-uat -r https://test.salesforce.com` first, then deploy in a new command.
- **Run `deploy quick` and `deploy cancel` on their own.** Do not combine them with other deploy commands in one Bash call.
- **Deploy to production outside Claude Code.** Use the CI pipeline, or a terminal outside Claude Code.

The guard needs a working login for the target org. If the login has expired, the guard cannot check the org, and it blocks the command. Log in again with `sf org login web -a <alias>`.

Example decisions:

| Command | Result |
| --- | --- |
| `sf project deploy start -d force-app -o my-sandbox` | Allowed, after a live check that `my-sandbox` is a sandbox |
| `sf project deploy start -d force-app` | Blocked: no explicit target |
| `sf project deploy start -d force-app -o acme-prod` | Blocked: production org |
| `sf data query -q "SELECT Id FROM Account" -o acme-prod` | Allowed: read-only |
| `sf project retrieve start -m ApexClass -o acme-prod` | Allowed: read-only |
| `sf apex run -f script.apex -o acme-prod` | Blocked: production org |
| `git commit -m "fix sf project deploy start -o prod"` | Allowed: text in a commit message is data |

---

## What the guard allows and blocks

### By command

`plugins/sf-prod-guard/guard/sf-command-table.json` lists every `sf` command, with its aliases (for example `deploy metadata` → `project deploy start`). The guard sorts each `sf` command into one of these kinds:

| Command kind | Examples | Decision |
| --- | --- | --- |
| Help | `--help`, `-h` | allow |
| Local, or Dev Hub scratch org and beta package work (no `--target-org`) | `org list`, `config get`, `org create scratch -v hub`, `package version create`, `project deploy resume`, `project deploy report` | allow |
| Read-only org commands | `data query`, `project retrieve start`, `org display`, `project deploy preview`, `sobject describe` | allow |
| Dev Hub changes that cannot be undone, or that affect subscribers | `package version promote`, `package delete`, `package version delete`, `package update`, `package version update`, `package push-upgrade abort` | **check the Dev Hub org** (needs `--target-dev-hub`) |
| Destination org cannot be verified | `project deploy pipeline start/quick/validate`, `devops promote`, `devops promotion complete/validate`, `package push-upgrade schedule`, `org delete sandbox` (deletes through the production parent) | **block** |
| All other org commands | `project deploy start/validate/quick/cancel`, `api request rest` (any method: a GET to `/tooling/executeAnonymous` runs Apex), `project delete source`, `apex run`, `apex run test`, `data create/update/delete/upsert/import`, `package install`, `org assign permset`, `org create user`, `org create sandbox` | **check the org** |
| Unknown commands (other plugins, newer CLI) | `sf sfdmu run ...`, `sf hardis ...` | **check the org** |

### By org

For each org that it must check, the guard reads live data from the org:

| Live `Organization` data | Decision |
| --- | --- |
| `Id` is in `allowed-orgs.json` and the entry has not expired | allow (demo org) |
| `IsSandbox = true` | allow |
| `OrganizationType` is `Developer Edition` or `Partner Developer Edition` | allow |
| `TrialExpirationDate` is set (trials, scratch orgs, demo orgs that expire) | allow |
| Anything else: Enterprise, Unlimited, Performance, Professional, Personal, Team, or Base Edition with no trial date | **block** |
| The query fails, returns no record, or takes too long | **block** |

---

## How it works

Claude Code runs the plugin's `PreToolUse` hook before each Bash command. The hook gets the command as JSON on stdin. It allows the command with exit code `0`, or blocks it with exit code `2`. When it blocks, Claude Code shows the reason to the model. The hook sets `"onFailure": "block"`, so Claude Code also blocks the command if the hook crashes or times out.

The hook entry is a small bash wrapper, `block-sf-prod-deploy.sh`. It finds Node.js, starts the guard under a 50-second deadline, and changes every failure into exit code 2. The guard logic is in `guard-lib.mjs`. It has four steps.

### Step 1: Parse the command as shell syntax

The guard does not search the command text with a regex. It parses the command the way a shell does:

- quotes, `\` escapes, `$'...'`, and line continuations
- comments
- heredocs and here-strings (data), and `$(...)` inside an unquoted heredoc (runs)
- `$(...)`, backticks, `<(...)`, subshells, arrays, and arithmetic
- `&&`, `||`, `;`, `|`, and new lines

It then finds each `sf` or `sfdx` call. It also finds calls behind these wrappers:

- `env` (also `env -S`), `sudo`, `time`, `timeout`, `nice`, `xargs`, `command`, `exec`, `script`, `trap`, `watch`
- `find -exec`, `eval`, `bash -c`, `sh -c`
- `npx @salesforce/cli`, `npm exec`, `node .../@salesforce/cli/bin/run.js`

It also checks the parts of `awk` (`system()`, `getline`, pipes), GNU `sed` (the `e` command), and `git -c` that can run commands.

It finds `sf` in these spellings of the command name:

- a path: `/opt/homebrew/bin/sf`
- quotes or escapes: `"sf"`, `s\f`
- a zsh `=sf`
- a brace expansion: `{sf,}`, `s{f..f}`
- a glob: `s[f]`, `[[:lower:]]f`

Text in a commit message, a PR body, an `echo`, a `grep` or `rg` pattern, or a quoted heredoc is data. It does not cause a block.

### Step 2: Classify each sf command

For each command, `sf-command-table.json` records:

- whether it takes `--target-org` or `--target-dev-hub`
- whether it takes positional arguments
- every flag spelling, with its arity (boolean or value)

The guard uses this table to read arguments the way `sf` (oclif) does. For example:

- `-rw5` is read as `-r -w 5`.
- In `--stream-to-file --target-org=x`, the word after `--stream-to-file` is a file name, not an org flag.
- `sf --dev-debug --debug-filter -h ...` is not a help request. `sf` removes `--debug-filter` and the word after it before it reads the command.
- A word that the command cannot take as an argument (for example `sf org list purge`) makes the command unknown. Unknown commands are checked as writes.
- `sf` accepts command words in another order (`sf delete org sandbox` = `sf org delete sandbox`). The guard resolves that order too.

If the table cannot load, the guard blocks every `sf` command. The [By command](#by-command) table shows the result of this step.

### Step 3: Require an explicit target

A command that is checked must name its org with `--target-org <alias>` (or `-o`). Hidden aliases of that flag, such as `-u` and `--targetusername`, also count. The guard does **not** use the default org, `SF_TARGET_ORG`, or `sf config`. These values depend on the folder and the environment, so the guard cannot read them reliably.

`sf project deploy quick` and `sf project deploy cancel` use the org saved with the job in `~/.sf/deploy-cache.json` before they use `--target-org`. The guard checks that cached org too.

The guard also blocks these cases:

- The target value is a shell expansion (`-o "$ORG"`). Write the literal alias.
- A flag value has an unquoted expansion that can split into more arguments (`--wait ${W:-5 --use-most-recent}`).
- The command has two different targets.
- A short-flag cluster hides the org flag (`-gu prod`). Write each flag separately.
- The command uses `--flags-dir`, which can change the target.
- The same Bash call changes an alias, login, or sf config (`sf alias set`, `sf org login ...`, `sf config set`) and also runs a checked command. The guard reads the alias *before* the command runs, so the alias must not change in the same call.
- The same Bash call runs `deploy quick` or `deploy cancel` together with another deploy command. The other command can change the deploy cache.
- The same Bash call sets `HOME`, `XDG_*`, or `SF_*`/`SFDX_*` variables and also runs a checked command. Variables that cannot change the org, such as `SF_LOG_LEVEL`, are permitted.
- The command name contains a shell expansion (`$C ...`, `eval "$C"`, `s${X:-f}`) in a command that can be a Salesforce command.
- Inline code (`python3 -c`, `node -e`, `perl -e`, `osascript -e`, and similar) or an `ssh` remote command mentions Salesforce. The guard cannot check code in another language or on another machine.
- `xargs` or `parallel` adds arguments to an `sf` command from its input, so the guard cannot see the full command. A complete read-only command (for example `xargs sf data query -q ... -o x`) is allowed.
- `sudo`, `doas`, or `su` runs a checked `sf` command as another user. That user has other org logins.
- A shell reads a script from a pipe (`... | bash`) and the command mentions Salesforce. A heredoc or here-string script (`bash <<EOF`) is parsed and checked like any other command.

### Step 4: Check the org with live data

For each target, the guard runs this query with the real `sf` CLI, in the folder where Claude Code runs the command:

```
sf data query --query "SELECT Id, Name, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization" --target-org <alias> --json
```

The [By org](#by-org) table shows the decision. The guard does not use the cached `isSandbox` or `isScratch` values from `sf org display`, or patterns in the instance URL. The live query is the only source.

Time limits: each query stops after 25 seconds, and the whole check stops after about 40 seconds. A watchdog in Node blocks at 45 seconds, and the wrapper stops Node at 50 seconds. Claude Code's limit for the hook is 60 seconds. Each limit ends in a block.

---

## Demo orgs (IDO, SDO)

Many IDOs and SDOs report `Enterprise Edition` or `Unlimited Edition` with no `TrialExpirationDate`. From live data alone, they look the same as a client's production org. To allow one, add its **Org ID** to `plugins/sf-prod-guard/guard/allowed-orgs.json` by pull request:

1. Get the Org ID:

   ```bash
   sf data query -q "SELECT Id, Name, OrganizationType, TrialExpirationDate FROM Organization" -o <demo-alias>
   ```

2. Add an entry to the `orgs` list:

   ```json
   {
     "orgs": [
       { "orgId": "00D5g000000XXXXEAA", "label": "Axios IDO", "kind": "IDO", "owner": "marc.swan", "expires": "2027-03-31" }
     ]
   }
   ```

3. Open a PR. After it merges, the change reaches each developer with the next plugin update (see [Update](#update)).

Rules:

- Use the Org ID, never an alias. Anyone can rename an alias on their own machine. An Org ID is the same everywhere and never changes.
- The Org ID must have 15 or 18 characters and start with `00D`.
- Set `expires` to a real date in `YYYY-MM-DD` format. The guard ignores an entry with no valid `expires` date, and an entry after that date.
- Give `label`, `kind` (`IDO` or `SDO`), and `owner`, so that reviewers know whose org it is.
- Never add a client's production org.

---

## Repository layout

```
.claude-plugin/marketplace.json     # this repo is a plugin marketplace named "ka-vault"
.claude/settings.json               # enables the plugin for sessions in this repo
plugins/sf-prod-guard/
├── .claude-plugin/plugin.json      # plugin manifest (no version field, on purpose)
├── hooks/hooks.json                # PreToolUse hook for Bash: timeout 60 s, onFailure "block"
└── guard/
    ├── block-sf-prod-deploy.sh     # hook entry: finds Node.js, changes every failure into exit 2
    ├── sf-prod-guard.mjs           # Node entry point
    ├── guard-lib.mjs               # shell parser, command classification, org check
    ├── sf-command-table.json       # every sf command, its flags, and whether it takes --target-org (generated)
    ├── gen-sf-command-table.mjs    # makes sf-command-table.json again from the installed sf CLI
    └── allowed-orgs.json           # Org ID allowlist for demo orgs (IDO, SDO)
managed/managed-settings.json       # policy that makes the plugin mandatory (Option C)
tests/guard.test.mjs                # end-to-end tests with a fake sf (no org access)
install.sh                          # installs the plugin and removes the old hook
```

`.claude/settings.json` adds the `ka-vault` marketplace and enables `sf-prod-guard@ka-vault` for sessions in this repo. Claude Code applies it after you trust the folder. So a teammate who opens this repo gets the guard in this repo even before they run `install.sh`. Only the user install (Option A or B) or managed settings (Option C) protect their other projects.

---

## Configuration reference

| Setting | Where | Effect |
| --- | --- | --- |
| `KA_VAULT_QUERY_TIMEOUT_MS` | Environment of Claude Code | Makes the org query time limit shorter (milliseconds). The limit cannot go above 25 000. |
| `KA_VAULT_MARKETPLACE` | Environment of `install.sh` | The marketplace source. Default: `Kelley-Austin/ka-vault`. A path to a local clone also works, for example to test a branch. |
| `CLAUDE_CONFIG_DIR` | Environment of `install.sh` and Claude Code | Claude Code reads user settings from this folder instead of `~/.claude`. Run `install.sh` with the same value that you use for Claude Code. |
| `allowed-orgs.json` | Plugin, by PR | Demo orgs to allow. See [Demo orgs](#demo-orgs-ido-sdo). |
| `disableAllHooks` | Claude Code settings | Must not be `true`. If it is, no hook runs, also not the guard. |

---

## Known limits

A hook only sees the text of the Bash command that Claude Code is about to run. These cases are outside its view:

- **Scripts.** `bash deploy.sh`, `npm run deploy`, `make deploy`, and similar commands run code that the guard cannot see. Do not put production deploys in scripts in a Claude Code workspace.
- **Shell aliases and functions.** Claude Code's Bash tool loads your shell profile. An alias or function there (for example `alias dp='sf project deploy start'`) hides `sf` from the guard. Do not define aliases or functions that wrap `sf` deploy or write commands.
- **Other tools.** A Salesforce MCP server, or `curl` with an access token, does not go through `sf` in a Bash command. Do not connect a Salesforce MCP server to a production org in Claude Code.
- **Older Claude Code versions.** Versions before 2.1.295 do not support `onFailure`. There, if Claude Code stops the hook at its 60-second limit, the command runs. The guard's own limits (40, 45, and 50 seconds) usually block first.
- **No Node.js.** Without Node.js, the guard cannot parse commands. It then uses a simple text check. It blocks a Bash command that mentions `sf` or Salesforce, or that uses ANSI-C quoting (`$'...'`). It also blocks an expansion, a brace, or a glob in a command name. It allows other commands. Install Node.js to get the full guard.
- **`bash -n`.** The guard skips `bash -n -c '...'` (syntax check only). It does not skip other shell options that prevent execution.
- **A user can turn the plugin off**, unless managed settings enable it (Option C).

The strongest control is credentials: do not log in to production orgs on a machine where Claude Code does Salesforce work.

---

## Policy decisions

- **No admin override.** The old 24-hour override let any deploy through, which broke the "never production" rule. Admins deploy to production through CI or from a terminal outside Claude Code.
- **`project deploy validate` and `--dry-run` against production are blocked.** They do not save metadata. But they run tests in production, and a validated job lets `deploy quick` deploy it.
- **Personal Edition is blocked.** It is a paid production edition, not a development org.
- **Dev Hub packaging changes that cannot be undone are checked.** `package version promote`, `package delete`, `package version delete`, `package update`, `package version update`, and `package push-upgrade abort` check the Dev Hub org. A production Dev Hub blocks them.
- **Scratch org, package create, and beta package version commands are allowed on a production Dev Hub.** They write records in the Dev Hub (`ScratchOrgInfo`, `Package2`, beta `Package2Version`). Dev Hubs are almost always production orgs, so blocking these commands would block all scratch org development. Decide as a team if `package create` and `package convert` must also be checked.
- **`org delete sandbox` is blocked.** `sf` removes the sandbox through its production parent org.
- **`project deploy cancel` against production is blocked.** A cancel changes an active production deployment.
- **`apex run test` and `apex tail log` against production are blocked.** Tests run code in production, and `apex tail log` creates trace flags.
- **Sandbox create, refresh, and delete against a production org are blocked.** These commands write to the production org.

---

## Development

### Run the tests

```bash
node --test tests/*.test.mjs
```

The tests run the real hook wrapper with a fake `sf`. They do not contact an org. They cover:

- every bypass and false positive found in review
- the fail-closed paths (bad input, timeouts, a missing `sf`, a missing Node.js, a missing command table)
- every allowed org type
- the plugin packaging: the manifests, the registered hook command, and no second registration of the hook

Test the hook by hand from the repo root:

```bash
# blocked: no explicit target
echo '{"tool_input":{"command":"sf project deploy start"}}' | bash plugins/sf-prod-guard/guard/block-sf-prod-deploy.sh; echo "exit $?"

# allowed: text in a commit message
echo '{"tool_input":{"command":"git commit -m \"sf project deploy start -o prod\""}}' | bash plugins/sf-prod-guard/guard/block-sf-prod-deploy.sh; echo "exit $?"
```

Check the plugin and marketplace manifests:

```bash
claude plugin validate plugins/sf-prod-guard && claude plugin validate .
```

The validator warns that the plugin has no version, no license, and no icon. These warnings are expected. The version is left out on purpose (see [Release](#release)). The license and icon are needed only for the public plugin directory.

### Make the command table again

After a Salesforce CLI upgrade, or after you install an `sf` plugin, make the command table again:

```bash
node plugins/sf-prod-guard/guard/gen-sf-command-table.mjs && node --test tests/*.test.mjs
```

The guard checks a command that is not in the table as a write. So an old table usually causes a false block, not a missed write. One exception: a new subcommand can be under an existing command that takes positional arguments (for example `sf config get <new-word>`). The guard reads it as that existing command. Make the table again after each `sf` upgrade or plugin install.

### Change the guard

1. Create a branch from `main`.
2. Write a test in `tests/guard.test.mjs` that fails without your change.
3. Make the change in `plugins/sf-prod-guard/guard/`.
4. Run the tests. All tests must pass.
5. Open a PR. Describe the bypass or false positive, and give the command that shows it.

To install your branch on your own machine before it merges, run `KA_VAULT_MARKETPLACE="$PWD" bash install.sh` from your clone. Run `bash install.sh` again after the merge, to go back to the GitHub marketplace.

### Release

`plugin.json` has no `version` field, on purpose. Claude Code then uses the commit SHA as the version, so each commit merged to `main` is a new plugin version. Do not add a `version` field. With one, users stay on that version until someone changes it, and a guard fix does not reach them. A test fails if `plugin.json` has a version.

### Tagged releases

A GitHub release marks a milestone. Its tag has the form `sf-prod-guard--v<major>.<minor>.<patch>`, for example `sf-prod-guard--v2.0.0`. Each release has these assets:

- `sf-prod-guard-<version>.zip`: the plugin folder (`plugins/sf-prod-guard/`) at the tagged commit.
- `sf-prod-guard-<version>.zip.sha256`: the SHA-256 checksum of the zip file.

A marketplace install (Option A, B, or C) always follows `main`, not the tags. Use the zip file to test a release, or on a machine that cannot reach GitHub. Load it for one session:

```bash
shasum -a 256 -c sf-prod-guard-2.0.0.zip.sha256
claude --plugin-dir sf-prod-guard-2.0.0.zip
```

`--plugin-dir` loads the plugin only for that session. For a permanent install, use Option A, B, or C.

To make a release:

1. Make sure that `main` passes all tests.
2. Make the zip file and its checksum from `main`:

   ```bash
   V=2.1.0
   git archive --format=zip -o "sf-prod-guard-$V.zip" origin/main:plugins/sf-prod-guard
   shasum -a 256 "sf-prod-guard-$V.zip" > "sf-prod-guard-$V.zip.sha256"
   ```

3. Create the release with the tag and the two assets:

   ```bash
   gh release create "sf-prod-guard--v$V" "sf-prod-guard-$V.zip" "sf-prod-guard-$V.zip.sha256" --target main --title "sf-prod-guard v$V" --notes "..."
   ```

---

## Troubleshooting

### install.sh stops with an error

| Message | Cause | What to do |
| --- | --- | --- |
| `install.sh needs 'jq'` | `jq` is not installed. | `brew install jq`, then run `install.sh` again. |
| `install.sh needs 'claude'` | The Claude Code CLI is not on your `PATH`. | Install Claude Code, or open a new terminal so that `PATH` is current. |
| `sets "disableAllHooks": true` | Your user settings turn off all hooks. | Remove `disableAllHooks` from the settings file named in the message, then run `install.sh` again. |
| `guard self-test failed` | The installed hook did not give the expected exit codes. | Check that `node --version` shows v18 or later. Run the commands in [Verify the install](#verify-the-install) step 2 to see the hook's message. |
| `is installed but not enabled` | The plugin could not be turned on. | Run `claude plugin enable sf-prod-guard@ka-vault`. If managed settings turn it off, ask your admin. |

### The guard does not run

1. Run `claude plugin list`. Make sure that `sf-prod-guard@ka-vault` shows `Status: ✔ enabled`.
2. Make sure that `disableAllHooks` is not `true` in your settings.
3. Quit and start Claude Code again. Claude Code loads plugins and hooks only when a session starts.

### The guard blocks a command

Read the message. It starts with `ka-vault guard: BLOCKED.` and gives the reason.

| Message | What to do |
| --- | --- |
| `... Add an explicit --target-org <alias>.` | Add `-o <alias>` to the command. |
| `Cannot confirm that org "<alias>" is not production (...)` | The guard could not query the org. Run `sf org list` to check that the alias exists. If the login has expired, log in again: `sf org login web -a <alias> -r https://test.salesforce.com` (for a sandbox). |
| `Org "<alias>" is a PRODUCTION org: ...` | The org is production. Deploy through CI or from a terminal outside Claude Code. If it is a demo org (IDO, SDO), add its Org ID to the allowlist (see [Demo orgs](#demo-orgs-ido-sdo)). |
| `allowed-orgs.json entry ... expired on ...` | The allowlist entry has expired. Open a PR with a new `expires` date if the demo org is still in use. |
| `The value of --target-org contains a shell expansion.` | Write the alias literally, not as a variable. |
| `... changes an org alias, login, or sf config, and also runs a command that changes an org.` | Run the alias, login, or config command first, as a separate command. |
| `... runs "sf project deploy quick" or "cancel" together with another deploy command.` | Run `deploy quick` or `deploy cancel` as a separate command. |
| `... is not permitted from Claude Code.` | The guard always blocks this command (for example a DevOps Center pipeline deploy). Run it from DevOps Center, CI, or a terminal outside Claude Code. |
| `The guard cannot find the sf CLI` | Install the Salesforce CLI, or make sure that it is on your `PATH`. |
| `Node.js is not available to the hook` | Install Node.js 18 or later, then restart Claude Code. |
| `The guard cannot load sf-command-table.json` | The plugin files are incomplete. Run `bash install.sh` again. |

### The guard blocks a command that only reads

Make the command table again: `node plugins/sf-prod-guard/guard/gen-sf-command-table.mjs`. If the command is still blocked, open an issue with the command, so that the team can add it to the read-only list in `plugins/sf-prod-guard/guard/guard-lib.mjs`.

### I need to deploy to production

Use the CI pipeline, or a terminal outside Claude Code. The guard has no override.
