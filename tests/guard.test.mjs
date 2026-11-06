// End-to-end tests for the ka-vault production guard.
// Run: node --test tests/
// The tests run the real hook wrapper with a fake `sf` on PATH. No org is contacted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, rmSync, cpSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_ONLY, ALWAYS_BLOCK, loadCommandTable, classify } from '../guard/guard-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_DIR = path.dirname(process.execPath);

const ORGS = {
  prod: { Id: '00D000000000001AAA', Name: 'Acme', IsSandbox: false, OrganizationType: 'Enterprise Edition', TrialExpirationDate: null },
  personal: { Id: '00D000000000002AAA', Name: 'Me', IsSandbox: false, OrganizationType: 'Personal Edition', TrialExpirationDate: null },
  sbx: { Id: '00D000000000003AAA', Name: 'Acme UAT', IsSandbox: true, OrganizationType: 'Enterprise Edition', TrialExpirationDate: null },
  dev: { Id: '00D000000000004AAA', Name: 'Dev', IsSandbox: false, OrganizationType: 'Developer Edition', TrialExpirationDate: null },
  trial: { Id: '00D000000000005AAA', Name: 'Trial', IsSandbox: false, OrganizationType: 'Enterprise Edition', TrialExpirationDate: '2027-01-01T00:00:00.000+0000' },
  sdo: { Id: '00D000000000006AAA', Name: 'SDO', IsSandbox: false, OrganizationType: 'Unlimited Edition', TrialExpirationDate: null },
  oldsdo: { Id: '00D000000000007AAA', Name: 'Old SDO', IsSandbox: false, OrganizationType: 'Unlimited Edition', TrialExpirationDate: null },
  noexp: { Id: '00D000000000008AAA', Name: 'SDO no expiry', IsSandbox: false, OrganizationType: 'Enterprise Edition', TrialExpirationDate: null },
  baddate: { Id: '00D000000000009AAA', Name: 'SDO bad date', IsSandbox: false, OrganizationType: 'Enterprise Edition', TrialExpirationDate: null },
  hang: 'hang',
  stubborn: 'stubborn',
};

const FAKE_SF = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_SF_LOG, JSON.stringify(args) + '\\n');
const orgs = JSON.parse(fs.readFileSync(process.env.FAKE_SF_ORGS, 'utf8'));
const t = args[args.indexOf('--target-org') + 1];
const org = orgs[t];
if (org === 'hang') { setTimeout(() => {}, 60000); return; }
if (org === 'stubborn') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); return; }
if (!org) { console.log(JSON.stringify({ status: 1, name: 'NamedOrgNotFoundError', message: 'No authorization information found for ' + t + '.' })); process.exit(1); }
console.log(JSON.stringify({ status: 0, result: { records: [org], totalSize: 1, done: true } }));
`;

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ka-guard-'));
  mkdirSync(path.join(dir, 'bin'));
  mkdirSync(path.join(dir, 'home', '.sf'), { recursive: true });
  const sf = path.join(dir, 'bin', 'sf');
  writeFileSync(sf, FAKE_SF);
  chmodSync(sf, 0o755);
  writeFileSync(path.join(dir, 'orgs.json'), JSON.stringify(ORGS));
  writeFileSync(path.join(dir, 'sf.log'), '');
  writeFileSync(path.join(dir, 'home', '.sf', 'deploy-cache.json'), JSON.stringify({
    '0Af000000000001AAA': { 'target-org': 'prod', timestamp: '2026-11-01T10:00:00.000Z' },
    '0Af000000000002AAA': { 'target-org': 'sbx', timestamp: '2026-11-02T10:00:00.000Z' },
  }));
  // Run a copy of the guard, so the test allowlist does not touch the real one.
  cpSync(path.join(ROOT, 'guard'), path.join(dir, 'guard'), { recursive: true });
  writeFileSync(path.join(dir, 'guard', 'allowed-orgs.json'), JSON.stringify({ orgs: [
    { orgId: ORGS.sdo.Id, label: 'Test SDO', kind: 'SDO', owner: 'tests', expires: '2099-12-31' },
    { orgId: ORGS.oldsdo.Id.slice(0, 15), label: 'Old SDO', kind: 'SDO', owner: 'tests', expires: '2020-01-01' },
    { orgId: ORGS.noexp.Id, label: 'No expiry', kind: 'SDO', owner: 'tests' },
    { orgId: ORGS.baddate.Id, label: 'Bad date', kind: 'SDO', owner: 'tests', expires: '2099-02-30' },
  ] }));
  return dir;
}

const DIR = setup();
const WRAPPER = path.join(DIR, 'guard', 'block-sf-prod-deploy.sh');
process.on('exit', () => rmSync(DIR, { recursive: true, force: true }));

function run(command, { input, pathDirs = [path.join(DIR, 'bin'), NODE_DIR, '/usr/bin', '/bin'], timeoutMs } = {}) {
  const payload = input ?? JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: DIR });
  const env = {
    PATH: pathDirs.join(':'),
    HOME: path.join(DIR, 'home'),
    FAKE_SF_ORGS: path.join(DIR, 'orgs.json'),
    FAKE_SF_LOG: path.join(DIR, 'sf.log'),
  };
  if (timeoutMs) env.KA_VAULT_QUERY_TIMEOUT_MS = String(timeoutMs);
  const r = spawnSync('/bin/bash', [WRAPPER], { input: payload, env, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stderr: r.stderr };
}

const queries = () => readFileSync(path.join(DIR, 'sf.log'), 'utf8').trim().split('\n').filter(Boolean).length;
const D = 'sf project deploy start';

function expectBlock(command, opts) {
  const r = run(command, opts);
  assert.equal(r.status, 2, `expected BLOCK (exit 2) for:\n${command}\nstderr: ${r.stderr}`);
  assert.match(r.stderr, /ka-vault guard: BLOCKED/);
  return r;
}
function expectAllow(command, opts) {
  const r = run(command, opts);
  assert.equal(r.status, 0, `expected ALLOW (exit 0) for:\n${command}\nstderr: ${r.stderr}`);
  return r;
}

// ── Bypasses found in review: each must now block ────────────────────────────

const bypasses = {
  'plain prod deploy': `${D} --target-org prod`,
  'double-quoted target': `${D} --target-org "prod"`,
  'single-quoted target': `${D} -o 'prod'`,
  'equals form': `${D} --target-org=prod`,
  'attached short flag': `${D} -oprod`,
  'echo prefix': `echo "Deploying..." && ${D} -o prod`,
  'comment first line': `# deploy the class\n${D} -o prod`,
  'printf with command substitution': `printf '%s\\n' "$(${D} -o prod)"`,
  'first -o is a safe query': `sf data query -q "SELECT Id FROM User" -o sbx && ${D} -o prod`,
  'safe deploy then prod deploy': `${D} -o sbx && ${D} -o prod`,
  'colon syntax': 'sf project:deploy:start -o prod',
  'absolute path': `/opt/homebrew/bin/${D} -o prod`,
  'quoted executable': `"sf" project deploy start -o prod`,
  'escaped executable': `s\\f project deploy start -o prod`,
  'ANSI-C executable': `$'sf' project deploy start -o prod`,
  'line continuation inside command id': 'sf project deploy \\\n  start -o prod',
  'bash -c': `bash -c "${D} -o prod"`,
  'sh -lc': `sh -lc '${D} -o prod'`,
  'eval': `eval "${D} -o prod"`,
  'eval of a variable': `C="${D} -o prod"; eval "$C"`,
  'variable as command name': `S=sf; $S project deploy start -o prod`,
  'npx salesforce cli': 'npx @salesforce/cli project deploy start -o prod',
  'npx -y versioned': 'npx -y @salesforce/cli@latest project deploy start -o prod',
  'node run.js': 'node /usr/local/lib/node_modules/@salesforce/cli/bin/run.js project deploy start -o prod',
  'env wrapper': `env -i ${D} -o prod`,
  'sudo wrapper': `sudo -u root ${D} -o prod`,
  'time wrapper': `time ${D} -o prod`,
  'find -exec': `find . -name x -exec ${D} -o prod \\;`,
  'subshell': `(cd force-app && ${D} -o prod)`,
  'backticks': `echo \`${D} -o prod\``,
  'unquoted heredoc runs substitution': `cat <<EOF\n$(${D} -o prod)\nEOF`,
  'deploy metadata alias': 'sf deploy metadata -o prod',
  'legacy sfdx -u': 'sfdx force:source:deploy -p force-app -u prod',
  'delete source': 'sf project delete source -m ApexClass:Foo -o prod --no-prompt',
  'package install': 'sf package install -p 04t000000000000 -o prod',
  'apex run': 'sf apex run -f changes.apex -o prod',
  'apex run from stdin': `echo 'delete [SELECT Id FROM Account];' | sf apex run -o prod`,
  'data update': 'sf data update record -s Account -i 001000000000000 -v "Name=X" -o prod',
  'api request POST': 'sf api request rest /services/data/v62.0/sobjects/Account --method POST --body @a.json -o prod',
  'api request graphql': 'sf api request graphql --body q.graphql -o prod',
  'validate against prod (kept blocked)': 'sf project deploy validate -o prod',
  'dry-run against prod (kept blocked)': `${D} --dry-run -o prod`,
  'Personal Edition': `${D} -o personal`,
  'unknown alias': `${D} -o nosuchorg`,
  'expired allowlist entry': `${D} -o oldsdo`,
  'hidden -u alias of --target-org': 'sf apex run -f x.apex -o sbx -u prod',
  'hidden --targetusername alias': 'sf data update record -s Account -i 001000000000000 -v "Name=X" --targetusername prod',
  'command with a later -v-like flag': `command ${D} -o prod --verbose`,
  'zsh =sf': `=${D} -o prod`,
  'brace expansion in command name': `{sf,} project deploy start -o prod`,
  'glob in command name': `/opt/homebrew/bin/s[f] project deploy start -o prod`,
  'glob ? in command name': `s? project deploy start -o prod`,
  'script wrapper': `script -q /dev/null ${D} -o prod`,
  'python inline code': `python3 -c "import os; os.system('${D} -o prod')"`,
  'node inline code': `node -e "require('child_process').execSync('${D} -o prod')"`,
  'osascript inline code': `osascript -e 'do shell script "${D} -o prod"'`,
  'ssh remote command': `ssh buildbox "${D} -o prod"`,
  // Second Codex review (checkpoint 2)
  'leading --dev-debug flag': `sf --dev-debug project deploy start -o prod`,
  'REST attached -f request file': 'sf api request rest -frequest.json -o prod',
  'REST with --flags-dir': 'sf api request rest /services/data/v62.0/sobjects/Account/001 -o prod --flags-dir ./delete-flags',
  'GNU time -f FORMAT': `/usr/bin/time -f %E ${D} -o prod`,
  'bash -o errexit -c': `bash -o errexit -c '${D} -o prod'`,
  'bash reads a heredoc script': `bash <<'EOF'\n${D} -o prod\nEOF`,
  'bash reads a here-string': `bash <<< "${D} -o prod"`,
  'script piped into bash': `echo "${D} -o prod" | bash`,
  'heredoc delimiter split by backslash-newline': `cat <<EOF\nEO\\\nF\n${D} -o prod`,
  'function keyword body': `function deploy { ${D} -o prod; }; deploy`,
  'expansion inside the command name': `s\${CLI_SUFFIX:-f} project deploy start -o prod`,
  'xargs supplies the whole sf command': `printf '%s\\n' 'project deploy start -o prod' | xargs sf`,
  'xargs appends to a deploy': `echo prod | xargs ${D} -o sbx`,
  'parallel': `parallel ${D} -o ::: prod`,
  'sudo as another user': `sudo -H -u deploy ${D} -o sbx`,
  'su -c': `su deploy -c '${D} -o sbx'`,
  'package version promote on a production Dev Hub': 'sf package version promote -p 04t000000000001AAA -v prod --no-prompt',
  'package version promote with no Dev Hub flag': 'sf package version promote -p 04t000000000001AAA --no-prompt',
  'deploy cancel against prod': 'sf project deploy cancel -o prod --job-id 0Af000000000009AAA',
  'deploy cancel of a cached prod job with a safe -o': 'sf project deploy cancel -o sbx --job-id 0Af000000000001AAA',
  'short-flag cluster that hides the target flag': 'sf apex run -f x.apex -o sbx -gu prod',
  'allowlist entry without expires': `${D} -o noexp`,
  'allowlist entry with an impossible date': `${D} -o baddate`,
  // Third Codex review
  'bash -eo pipefail -c (option cluster with an argument)': `bash -eo pipefail -c '${D} -o prod'`,
  'bash -n +n -c (noexec reset)': `bash -n +n -c '${D} -o prod'`,
  'node --eval=CODE': `node --eval="require('child_process').execSync('${D} -o prod')"`,
  'python -cCODE (attached)': `python3 -c"import os; os.system('${D} -o prod')"`,
  'env --split-string=TEXT': `env --split-string="${D} -o prod"`,
  'script -qc cluster': `script -qc "${D} -o prod" /dev/null`,
  'setsid wrapper': `setsid ${D} -o prod`,
  'stdbuf wrapper': `stdbuf -oL ${D} -o prod`,
  'flock wrapper': `flock /tmp/deploy.lock ${D} -o prod`,
  'unknown wrapper (generic fallback)': `somewrapper --flag ${D} -o prod`,
  'sudo into a nested shell': `sudo -H -u deploy bash -c '${D} -o sbx'`,
  'expansion that adds a cache selector': `sf project deploy quick -o sbx \${RECENT:---use-most-recent}`,
  'option value that looks like the org flag': `sf api request rest /services/data/v62.0/sobjects/Account --method POST --body '{}' --stream-to-file --target-org=sbx`,
  'heredoc delimiter that looks like an expansion': `cat <<"\${EOF}"\nnotes\n\${EOF}\n${D} -o prod`,
  'ANSI-C Unicode escape in the command name': `$'\\u0073f' project deploy start -o prod`,
  'sandbox delete (runs through the production parent)': 'sf org delete sandbox -o sbx --no-prompt',
  'unknown child of a read-only command (space form)': 'sf org list purge -o prod',
  'unknown child of a read-only command (colon form)': 'sf org:list:purge -o prod',
  // Fourth Codex review
  'REST GET that runs Apex (executeAnonymous)': `sf api request rest '/services/data/v65.0/tooling/executeAnonymous/?anonymousBody=delete%20%5BSELECT%20Id%20FROM%20Account%5D%3B' -o prod`,
  'REST GET on prod': 'sf api request rest /services/data/v62.0/limits -o prod',
  'permuted command words: sandbox delete': 'sf delete org sandbox -o sbx --no-prompt',
  'permuted command words: quick deploy of a cached prod job': 'sf deploy project quick --job-id 0Af000000000001AAA -o sbx',
  'ANSI-C heredoc delimiter': `cat <<$'EOF'\nnotes\nEOF\n${D} -o prod`,
  'locale heredoc delimiter': `cat <<$"EOF"\nnotes\nEOF\n${D} -o prod`,
  'env -S keeps argument boundaries': `env -S 'bash -c' '${D} -o prod'`,
  'watch -x': `watch -x bash -c '${D} -o prod'`,
  'env --argv0 value': `env --argv0 echo ${D} -o prod`,
  'partly quoted glob in the command name': `"/opt/homebrew/bin/"s[f] project deploy start -o prod`,
  'extended glob in the command name': `bash -O extglob -c '/opt/homebrew/bin/@(sf|sfdx) project deploy start -o prod'`,
  'NUL in ANSI-C command name': `$'sf\\0ignored' project deploy start -o prod`,
  'wrapper chain longer than the limit': `${'env '.repeat(70)}${D} -o prod`,
  // Fifth Codex review
  'debug filter value read as help': 'sf --dev-debug --debug-filter -h project deploy start -o prod',
  'debug filter value hides the command': `sf --dev-debug --debug-filter '*' org delete sandbox -o sbx --no-prompt`,
  'expansion in a flag value adds a cache selector': `sf project deploy quick -o sbx --wait \${WAIT:-5 --use-most-recent}`,
  'resume changes the cache before quick --use-most-recent': 'sf project deploy resume --job-id 0Af000000000001AAA && sf project deploy quick --use-most-recent -o sbx',
  'awk system()': `awk 'BEGIN {system("${D} -o prod")}'`,
  'GNU sed e command': `sed -n '1e ${D} -o prod' README.md`,
  'git -c shell alias': `git -c alias.deploy='!${D} -o prod' deploy`,
  'env -S with GNU escapes': `env -S 'sf\\_project\\_deploy\\_start\\_-o\\_prod'`,
  'script -c with an attached value': `script -qc'${D} -o prod' /dev/null`,
  'quoted parenthesis in an array, then an ANSI-C command name': `a=("("); $'\\x73\\x66' project deploy start -o prod`,
};
for (const [name, command] of Object.entries(bypasses)) {
  test(`blocks: ${name}`, () => { expectBlock(command); });
}

// ── Commands without a verifiable target ─────────────────────────────────────

const noTarget = {
  'no target (default org)': D,
  'SF_TARGET_ORG prefix': `SF_TARGET_ORG=prod ${D}`,
  'config set then deploy': `sf config set target-org prod && ${D}`,
  'cd then deploy': `cd /projects/production && ${D}`,
  'target from variable': `${D} -o "$ORG"`,
  'target from substitution': `${D} --target-org=$(cat org.txt)`,
  'two different targets': `${D} -o sbx -o prod`,
  'flags-dir': `${D} -o sbx --flags-dir ./flags`,
  'alias set in same command': `sf alias set sbx=admin@acme.com && ${D} -o sbx`,
  'login in same command': `sf org login web -a sbx -r https://login.salesforce.com && ${D} -o sbx`,
  'HOME override': `HOME=/tmp/other ${D} -o sbx`,
  'export SF_ variable': `export SF_ORG_INSTANCE_URL=https://acme.my.salesforce.com; ${D} -o sbx`,
  'unknown plugin command with no target': 'sf sfdmu run --sourceusername csvfile',
  'DevOps Center pipeline deploy': 'sf project deploy pipeline start --branch-name main --devops-center-username dc',
  'DevOps Center promote': 'sf devops promote -o dc',
  'push upgrade': 'sf package push-upgrade schedule -p 04t000000000000 --start-time now --org-list x -v hub',
  'unclosed quote': `${D} -o "prod`,
};
for (const [name, command] of Object.entries(noTarget)) {
  test(`blocks: ${name}`, () => { expectBlock(command); });
}

test('blocks: quick deploy whose cached job targets prod, even with a safe -o', () => {
  const r = expectBlock('sf project deploy quick --job-id 0Af000000000001AAA -o sbx');
  assert.match(r.stderr, /"prod" is a PRODUCTION org/);
});
test('blocks: quick deploy --use-most-recent when the newest cached job targets prod', () => {
  writeFileSync(path.join(DIR, 'home', '.sf', 'deploy-cache.json'), JSON.stringify({
    '0Af000000000001AAA': { 'target-org': 'prod', timestamp: '2026-11-03T10:00:00.000Z' },
    '0Af000000000002AAA': { 'target-org': 'sbx', timestamp: '2026-11-02T10:00:00.000Z' },
  }));
  try {
    expectBlock('sf project deploy quick --use-most-recent -o sbx');
  } finally {
    writeFileSync(path.join(DIR, 'home', '.sf', 'deploy-cache.json'), JSON.stringify({
      '0Af000000000001AAA': { 'target-org': 'prod', timestamp: '2026-11-01T10:00:00.000Z' },
      '0Af000000000002AAA': { 'target-org': 'sbx', timestamp: '2026-11-02T10:00:00.000Z' },
    }));
  }
});
test('blocks: quick deploy -rw cluster (= -r -w) when the newest cached job targets prod', () => {
  const cacheFile = path.join(DIR, 'home', '.sf', 'deploy-cache.json');
  const saved = readFileSync(cacheFile, 'utf8');
  writeFileSync(cacheFile, JSON.stringify({ '0Af000000000001AAA': { 'target-org': 'prod', timestamp: '2026-11-04T10:00:00.000Z' } }));
  try {
    expectBlock('sf project deploy quick -rw 5 -o sbx');
  } finally {
    writeFileSync(cacheFile, saved);
  }
});
test('blocks: quick deploy -rw5 cluster with an attached value when the newest cached job targets prod', () => {
  const cacheFile = path.join(DIR, 'home', '.sf', 'deploy-cache.json');
  const saved = readFileSync(cacheFile, 'utf8');
  writeFileSync(cacheFile, JSON.stringify({ '0Af000000000001AAA': { 'target-org': 'prod', timestamp: '2026-11-04T10:00:00.000Z' } }));
  try {
    expectBlock('sf project deploy quick -rw5 -o sbx');
  } finally {
    writeFileSync(cacheFile, saved);
  }
});
test('blocks quickly: exponential brace expansion before a prod deploy', () => {
  const t = Date.now();
  expectBlock(`'${'{a,b}'.repeat(40)}'; {x,y}${'{a,b}'.repeat(30)}; ${D} -o prod`);
  assert.ok(Date.now() - t < 10_000, `took ${Date.now() - t} ms`);
});
test('allows: quick deploy whose cached job targets a sandbox', () => {
  expectAllow('sf project deploy quick --job-id 0Af000000000002AAA -o sbx');
});

// ── Fail-closed paths ────────────────────────────────────────────────────────

test('blocks: a 300 KB command with a prod deploy at the start (old SIGPIPE fail-open)', () => {
  expectBlock(`${D} -o prod\n#${'x'.repeat(300_000)}`);
});
test('blocks: malformed hook input', () => {
  expectBlock('', { input: '{' });
});
test('blocks: hook input without a command', () => {
  expectBlock('', { input: JSON.stringify({ tool_input: {} }) });
});
test('blocks: org query that does not finish in time', () => {
  const t = Date.now();
  expectBlock(`${D} -o hang`, { timeoutMs: 1500 });
  assert.ok(Date.now() - t < 20_000);
});
test('blocks: org query that ignores SIGTERM (hard deadline)', () => {
  const t = Date.now();
  expectBlock(`${D} -o stubborn`, { timeoutMs: 1500 });
  assert.ok(Date.now() - t < 15_000, `took ${Date.now() - t} ms`);
});
test('no Node.js: a harmless command in a Salesforce-named folder is allowed', (t) => {
  if (['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/bin/node'].some(existsSync)) { t.skip('a system node exists at a fallback path'); return; }
  const input = JSON.stringify({ tool_input: { command: 'git status' }, cwd: '/work/salesforce-sf' });
  expectAllow('', { input, pathDirs: ['/usr/bin', '/bin'] });
});
test('blocks: command table missing (no fail-open on cached quick deploy)', () => {
  const g = path.join(DIR, 'guard-notable');
  cpSync(path.join(DIR, 'guard'), g, { recursive: true });
  rmSync(path.join(g, 'sf-command-table.json'));
  const input = JSON.stringify({ tool_input: { command: 'sf project deploy quick --job-id 0Af000000000001AAA -o sbx' }, cwd: DIR });
  const r = spawnSync('/bin/bash', [path.join(g, 'block-sf-prod-deploy.sh')], {
    input, encoding: 'utf8',
    env: { PATH: [path.join(DIR, 'bin'), NODE_DIR, '/usr/bin', '/bin'].join(':'), HOME: path.join(DIR, 'home'), FAKE_SF_ORGS: path.join(DIR, 'orgs.json'), FAKE_SF_LOG: path.join(DIR, 'sf.log') },
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /cannot load sf-command-table/);
});
test('blocks: sf CLI not found', () => {
  // Only valid when no sf exists at the fixed fallback paths on this machine.
  if (['/opt/homebrew/bin/sf', '/usr/local/bin/sf'].some(existsSync)) return;
  expectBlock(`${D} -o sbx`, { pathDirs: [NODE_DIR, '/usr/bin', '/bin'] });
});
test('no Node.js: blocks hidden command names, allows argument expansions', (t) => {
  if (['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/bin/node'].some(existsSync)) { t.skip('a system node exists at a fallback path'); return; }
  const p = { pathDirs: ['/usr/bin', '/bin'] };
  expectBlock('"$CLI" project deploy start -o prod', p);
  expectBlock(`$'\\x73\\x66' project deploy start -o prod`, p);
  expectBlock('X=1 $CLI project deploy start -o prod', p);
  expectAllow('echo "$HOME"; ls $TMPDIR', p);
});
test('no Node.js: blocks Salesforce commands, allows other commands', (t) => {
  if (['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/bin/node'].some(existsSync)) { t.skip('a system node exists at a fallback path'); return; }
  expectBlock(`${D} -o sbx`, { pathDirs: ['/usr/bin', '/bin'] });
  expectAllow('ls -la', { pathDirs: ['/usr/bin', '/bin'] });
});

// ── Permitted targets ────────────────────────────────────────────────────────

const allowedTargets = {
  'sandbox from live IsSandbox (Enterprise Edition, legacy URL)': `${D} -o sbx`,
  'Developer Edition': `${D} -o dev -d force-app`,
  'trial / scratch (TrialExpirationDate set)': `${D} -o trial`,
  'allowlisted SDO by Org ID': `${D} -o sdo`,
  'harmless SF_ variable': `SF_LOG_LEVEL=debug ${D} -o sbx`,
  'cd then explicit sandbox': `cd force-app && ${D} -o sbx`,
  'apex run on sandbox': 'sf apex run -f x.apex -o sbx',
  'line-continued sandbox deploy': `${D} \\\n  --target-org sbx \\\n  --source-dir force-app`,
  'hidden -u alias on a sandbox': 'sf apex run -f x.apex -u sbx',
  'legacy command alias with -u': 'sf force:apex:execute -u dev -f changes.apex',
  'package version promote on a Developer Edition Dev Hub': 'sf package version promote -p 04t000000000001AAA -v dev --no-prompt',
  'deploy cancel of a cached sandbox job': 'sf project deploy cancel -o sbx --job-id 0Af000000000002AAA',
  'REST GET on a sandbox': 'sf api request rest /services/data/v62.0/limits -o sbx',
};
for (const [name, command] of Object.entries(allowedTargets)) {
  test(`allows: ${name}`, () => { expectAllow(command); });
}

// ── False positives: these must pass without any org query ───────────────────

const noQuery = {
  'git commit with heredoc message': `git commit -m "$(cat <<'EOF'\nDocs: explain guard\n\n${D} -o prod is blocked (see README)\nEOF\n)"`,
  'rg for the deploy text': `rg 'example: ${D} -o prod' README.md`,
  'gh pr body': `gh pr create --title x --body "Run ${D} -o prod to see the block"`,
  'echo of the command': `echo "${D} -o prod"`,
  'quoted heredoc to a file': `cat > notes.md <<'EOF'\n${D} -o prod\nEOF`,
  'deploy --help': `${D} --help`,
  'deploy -h': `${D} -o prod -h`,
  'deploy resume': 'sf project deploy resume --job-id 0Af000000000001AAA',
  'deploy report': 'sf project deploy report --use-most-recent',
  'deploy preview': 'sf project deploy preview -o prod',
  'retrieve from prod': 'sf project retrieve start -m ApexClass -o prod',
  'query prod': 'sf data query -q "SELECT Id FROM Account LIMIT 1" -o prod',
  'org display': 'sf org display -o prod --json',
  'org list': 'sf org list',
  'org login alone': 'sf org login web -a newsbx -r https://test.salesforce.com',
  'alias set alone': 'sf alias set x=y',
  'config get': 'sf config get target-org',
  'scratch org create (Dev Hub)': 'sf org create scratch -f config/project-scratch-def.json -a so -v devhub',
  'package version create (Dev Hub)': 'sf package version create -p pkg -v devhub -x',
  'sf --version': 'sf --version',
  'command -v sf': 'command -v sf',
  'non-Salesforce command': 'ls -la && git status',
  'npm run script (not visible, documented limit)': 'npm run deploy',
  'python inline code without Salesforce': `python3 -c "print(1)"`,
  'glob that does not match sf': 'ls [abc]*',
  'ssh without Salesforce': 'ssh buildbox uptime',
  'bash -n syntax check only': `bash -n -c '${D} -o prod'`,
  'harmless pipe into bash': 'echo "echo hi" | bash',
  'xargs into a complete read-only command': 'echo x | xargs sf data query -q "SELECT Id FROM Account" -o prod',
  'heredoc delimiter that looks like a command': `cat <<"$(${D} -o prod)"\nnotes\n$(${D} -o prod)\n`,
  'guard table generator': 'node guard/gen-sf-command-table.mjs',
  'array assignment is data': `cmd=(${D} -o prod); printf '%q ' "\${cmd[@]}"`,
  'extended glob that does not match sf': `bash -O extglob -c 'ls @(a|b).txt'`,
  'single-quoted substitution in an array is data': `examples=('$(${D} -o prod)'); printf '%s\\n' "\${examples[@]}"`,
  'sed substitution that mentions sf': `sed -i '' 's/sf project deploy start/sf project deploy validate/' README.md`,
  'awk filter that mentions sf': `awk '/sf project deploy/ {print $1}' notes.txt`,
  'git -c with a commit message that mentions sf': `git -c user.name=ci commit -m "${D} -o prod"`,
  'dev-debug on a read-only command': 'sf --dev-debug --debug-filter sf:* org list',
  'quick deploy alone': 'sf project deploy report --job-id 0Af000000000002AAA',
  'arithmetic with a command substitution': 'start=$(date +%s); bash guard/block-sf-prod-deploy.sh < in.json; echo "took $(( $(date +%s) - start ))s"',
};
for (const [name, command] of Object.entries(noQuery)) {
  test(`allows without org query: ${name}`, () => {
    const before = queries();
    expectAllow(command);
    assert.equal(queries(), before, 'the guard queried an org for a command that does not need it');
  });
}

// ── Unit checks ──────────────────────────────────────────────────────────────

test('every READ_ONLY and ALWAYS_BLOCK id exists in the command table', () => {
  const table = loadCommandTable(path.join(ROOT, 'guard', 'sf-command-table.json'));
  const ids = new Set([...table.values()].map((e) => e.id));
  assert.deepEqual([...READ_ONLY, ...ALWAYS_BLOCK.keys()].filter((i) => !ids.has(i)), []);
});

test('classify: production editions are never allowed', () => {
  const none = { entries: [], problems: [] };
  for (const type of ['Enterprise Edition', 'Unlimited Edition', 'Professional Edition', 'Performance Edition', 'Personal Edition', 'Team Edition', 'Base Edition']) {
    assert.equal(classify({ Id: '00D000000000009AAA', IsSandbox: false, OrganizationType: type, TrialExpirationDate: null }, none).ok, false, type);
  }
});
