#!/usr/bin/env node
// Regenerate guard/sf-command-table.json from the installed sf CLI.
// Run after a Salesforce CLI upgrade, or after you install an sf plugin:
//   node guard/gen-sf-command-table.mjs
// The guard treats a command that is not in the table as a write. It then
// requires --target-org and checks the org. So a stale table can only cause a
// false positive, never a missed production write.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (args) => execFileSync('sf', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const commands = JSON.parse(run(['commands', '--json']));
const version = run(['--version']).trim().split(' ')[0];
// For each command: whether it takes --target-org / --target-dev-hub, whether
// it takes positional arguments, and every flag spelling with its arity
// (1 = boolean, 0 = takes a value). The guard parses sf arguments the way
// oclif does, so a value such as "--stream-to-file --target-org=x" is read
// as a file name, not as an org flag.
const entryFor = (c) => {
  const flags = {};
  for (const [key, f] of Object.entries(c.flags ?? {})) {
    const def = [key, f.type === 'boolean' ? 1 : 0];
    flags[`--${key}`] = def;
    if (f.char) flags[`-${f.char}`] = def;
    for (const a of f.aliases ?? []) flags[a.length === 1 ? `-${a}` : `--${a}`] = def;
    for (const a of f.charAliases ?? []) flags[`-${a}`] = def;
    if (f.type === 'boolean' && f.allowNo) flags[`--no-${key}`] = def;
  }
  return {
    org: Boolean(c.flags?.['target-org']),
    hub: Boolean(c.flags?.['target-dev-hub']),
    // strict: false means the command takes any number of positional arguments.
    args: Object.keys(c.args ?? {}).length > 0 || c.strict === false,
    flags,
  };
};
const table = {};
const aliases = {};
for (const c of [...commands].sort((a, b) => a.id.localeCompare(b.id))) table[c.id] = entryFor(c);
for (const c of commands) for (const a of c.aliases ?? []) if (!table[a]) aliases[a] = c.id;
const out = { format: 2, generatedFrom: version, generatedAt: new Date().toISOString().slice(0, 10), commands: table, aliases };
writeFileSync(path.join(here, 'sf-command-table.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`Wrote ${Object.keys(table).length} commands and ${Object.keys(aliases).length} aliases from ${version}.`);
