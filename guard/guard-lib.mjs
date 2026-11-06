#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────────
// ka-vault production guard: decision logic (library).
//
// sf-prod-guard.mjs is the entry point. block-sf-prod-deploy.sh calls it. Claude Code sends the PreToolUse
// JSON for the Bash tool on stdin.
//
// Exit codes:
//   0 = allow the command.
//   2 = block the command. The reason goes to stderr. Claude Code shows it to
//       the model.
// The wrapper changes all other exit codes to 2 (fail closed).
//
// Mandate: allow writes to sandboxes, scratch orgs, Developer Edition orgs,
// trial orgs, and allowlisted demo orgs (IDO/SDO). Never allow a write to a
// production org.
//
// Method:
//   1. Parse the command as shell syntax: quotes, escapes, comments, heredocs,
//      command substitution, subshells, wrappers (env, sudo, npx, bash -c, ...).
//   2. Find each sf/sfdx call. Classify it with sf-command-table.json
//      (generated from `sf commands --json`):
//        - help, read-only, local, and Dev Hub commands: allow.
//        - commands whose destination org cannot be known: block.
//        - all other org commands, and unknown commands: check the org.
//   3. A checked command must name its org with an explicit --target-org.
//      The guard does not use the default org.
//   4. Query Organization on that org (live data, not the local auth cache).
//      Allow only if IsSandbox, Developer Edition, TrialExpirationDate is set,
//      or the Org ID is in allowed-orgs.json. Block everything else.
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, statSync, readdirSync, writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START = Date.now();
const TOTAL_BUDGET_MS = 40_000; // settings.json timeout is 60 s. Stay well below it.
const QUERY_TIMEOUT_MS = Math.min(
  25_000,
  Number(process.env.KA_VAULT_QUERY_TIMEOUT_MS) > 0 ? Number(process.env.KA_VAULT_QUERY_TIMEOUT_MS) : 25_000,
); // The environment can only make the timeout shorter. A timeout blocks.

const ORG_SOQL = 'SELECT Id, Name, IsSandbox, OrganizationType, TrialExpirationDate FROM Organization';
const DEV_EDITION_TYPES = new Set(['Developer Edition', 'Partner Developer Edition']);

// Commands that have --target-org but do not change the org.
export const READ_ONLY = new Set([
  'agent:adl:file:list', 'agent:adl:get', 'agent:adl:list', 'agent:adl:status',
  'agent:mcp:asset:list', 'agent:mcp:get', 'agent:mcp:list',
  'agent:test:list', 'agent:test:results',
  'apex:get:log', 'apex:get:test', 'apex:list:log',
  'cmdt:generate:fromorg', 'code-analyzer:run', 'community:list:template',
  'data:bulk:results', 'data:export:bulk', 'data:export:tree', 'data:get:record',
  'data:query', 'data:search', 'data:resume', 'data:delete:resume', 'data:upsert:resume',
  'devops:pipeline:get', 'devops:pipeline:list', 'devops:project:list',
  'devops:request:status', 'devops:work-item:list',
  'flow:get:test', 'force:data:bulk:status', 'logic:get:test',
  'lightning:dev:app', 'lightning:dev:component', 'lightning:dev:site',
  'org:auth:show-access-token', 'org:auth:show-sfdx-auth-url', 'org:auth:show-user-password',
  'org:disable:tracking', 'org:enable:tracking',
  'org:display', 'org:display:user', 'org:list:limits', 'org:list:metadata',
  'org:list:metadata-types', 'org:list:sobject:record-counts', 'org:list:users',
  'org:open', 'org:open:agent',
  'package1:version:create:get', 'package1:version:display', 'package1:version:list',
  'package:install:report', 'package:installed:list', 'package:uninstall:report',
  'project:convert:source-behavior', 'project:delete:tracking', 'project:reset:tracking',
  'project:deploy:preview', 'project:deploy:report',
  'project:retrieve:preview', 'project:retrieve:start',
  'sobject:describe', 'sobject:list',
  'template:generate:digital-experience:site', 'ui-bundle:dev',
]);

// Commands whose destination org the guard cannot verify. Always block.
export const ALWAYS_BLOCK = new Map([
  ['project:deploy:pipeline:start', 'A DevOps Center pipeline stage sets the destination org. The guard cannot verify it.'],
  ['project:deploy:pipeline:quick', 'A DevOps Center pipeline stage sets the destination org. The guard cannot verify it.'],
  ['project:deploy:pipeline:validate', 'A DevOps Center pipeline stage sets the destination org. The guard cannot verify it.'],
  ['devops:promote', 'A DevOps Center pipeline stage sets the destination org. The guard cannot verify it.'],
  ['devops:promotion:complete', 'A DevOps Center pipeline stage sets the destination org. The guard cannot verify it.'],
  ['devops:promotion:validate', 'A DevOps Center pipeline stage sets the destination org. The guard cannot verify it.'],
  ['package:push-upgrade:schedule', 'A push upgrade installs into subscriber orgs. Subscriber orgs can be production.'],
  ['org:delete:sandbox', 'sf deletes the sandbox through its production parent org (SandboxInfo in the parent).'],
]);

// Commands that change which org an alias, login, or default points to.
const LOCAL_STATE = /^(alias:(set|unset)|config:(set|unset)|org:login(:.*)?|org:logout|force:alias:set|force:config:set|auth:.*|force:auth:.*)$/;

// Environment variables that do not change which org sf uses.
const SAFE_ENV = new Set([
  'SF_LOG_LEVEL', 'SFDX_LOG_LEVEL', 'SF_DISABLE_TELEMETRY', 'SFDX_DISABLE_TELEMETRY',
  'SF_DISABLE_AUTOUPDATE', 'SF_AUTOUPDATE_DISABLE', 'SFDX_AUTOUPDATE_DISABLE',
  'SF_JSON_TO_STDOUT', 'SFDX_JSON_TO_STDOUT', 'SF_SKIP_NEW_VERSION_CHECK',
  'SF_HIDE_RELEASE_NOTES', 'SF_HIDE_RELEASE_NOTES_FOOTER', 'SFDX_HIDE_RELEASE_NOTES',
  'SF_DISABLE_LOG_FILE', 'SF_NO_COLOR', 'SF_USE_PROGRESS_BAR', 'SFDX_USE_PROGRESS_BAR',
  'SF_CONTENT_TYPE', 'SFDX_CONTENT_TYPE',
]);
const isSensitiveEnv = (name) =>
  name === 'HOME' || name === 'USERPROFILE' || name.startsWith('XDG_') ||
  ((name.startsWith('SF_') || name.startsWith('SFDX_')) && !SAFE_ENV.has(name));

// ── Shell parser ─────────────────────────────────────────────────────────────
// Produces every simple command in the script, including commands inside
// $(...), `...`, <(...), subshells, and unquoted heredoc bodies.
// A word is { v: text, exp: contains an expansion, quoted: had quoting }.

export class ParseError extends Error {}
const META = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);
const newWord = () => ({ v: '', exp: false, quoted: false });

class Parser {
  constructor(src, out) {
    this.s = src;
    this.i = 0;
    this.out = out;
    this.heredocs = [];
  }

  parseList(term) {
    let words = [];
    let word = null;
    const endWord = () => { if (word) { words.push(word); word = null; } };
    const endCmd = () => { endWord(); if (words.length) this.out.push(words); words = []; };
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      const n = this.s[this.i + 1];
      if (c === '\\' && n === '\n') { this.i += 2; continue; }
      if (c === ')') { endCmd(); this.i++; if (term === ')') return; continue; }
      if ((c === '<' || c === '>') && n === '(') {
        // Process substitution: the inner commands run.
        endWord();
        this.i += 2;
        this.parseList(')');
        word = { v: '<(…)', exp: true, quoted: false };
        continue;
      }
      if (c === '(' && word && !word.quoted) {
        if (/^[A-Za-z_][A-Za-z0-9_]*\+?=$/.test(word.v)) {
          // Array assignment a=(x y z): data. Only substitutions inside it run.
          // Read the elements as words, so that single quotes keep text literal.
          const inner = this.readBalanced();
          const ep = new Parser(inner, this.out);
          while (ep.i < ep.s.length) {
            const ch = ep.s[ep.i];
            if (ch === ' ' || ch === '\t' || ch === '\n') { ep.i++; continue; }
            if (ch === '#') { while (ep.i < ep.s.length && ep.s[ep.i] !== '\n') ep.i++; continue; }
            if (!ep.readWord()) ep.i++; // a metacharacter in an element: skip it
          }
          word.v += '(…)';
          continue;
        }
        if (/[@?*+!]$/.test(word.v)) {
          // Extended glob such as @(sf|x): part of the word, not a subshell.
          const inner = this.readBalanced();
          new Parser(inner, this.out).readDoubleBody(newWord(), false);
          word.v += `(${inner})`;
          word.glob = true;
          continue;
        }
      }
      if (c === '(') { endCmd(); this.i++; this.parseList(')'); continue; }
      if (c === ' ' || c === '\t') { endWord(); this.i++; continue; }
      if (c === '\n') { endCmd(); this.i++; this.readHeredocBodies(); continue; }
      if (c === '<' || c === '>' || (c === '&' && n === '>')) {
        if (word && !word.quoted && !word.exp && /^\d+$/.test(word.v)) word = null; // fd number, e.g. 2>
        else endWord();
        this.readRedirect(words);
        continue;
      }
      if (c === ';' || c === '&' || c === '|') { endCmd(); this.i++; continue; }
      if (c === '#' && !word) {
        while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
        continue;
      }
      if (!word) word = newWord();
      this.readWordPart(word);
    }
    if (term === ')') throw new ParseError('a "(" has no matching ")"');
    endCmd();
  }

  // owner: the word list of the command that gets this redirection. A heredoc
  // or here-string body is stored on it as owner.stdinText, so that
  // "bash <<EOF" and "bash <<< text" can be checked.
  // At "(": return the text up to the matching ")" and move past it.
  readBalanced() {
    let depth = 0;
    const start = this.i + 1;
    for (let j = this.i; j < this.s.length; j++) {
      const c = this.s[j];
      if (c === '\\') { j++; continue; }
      if (c === "'") { const e = this.s.indexOf("'", j + 1); if (e < 0) break; j = e; continue; }
      if (c === '"') {
        // Parentheses in double quotes do not count. Skip to the closing quote.
        let e = j + 1;
        while (e < this.s.length && this.s[e] !== '"') e += this.s[e] === '\\' ? 2 : 1;
        if (e >= this.s.length) break;
        j = e;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) { this.i = j + 1; return this.s.slice(start, j); }
    }
    throw new ParseError('a "(" has no matching ")"');
  }

  readRedirect(owner) {
    const ops = ['&>>', '&>', '<<<', '<<-', '<<', '<>', '<&', '>>', '>|', '>&', '<', '>'];
    const op = ops.find((o) => this.s.startsWith(o, this.i));
    this.i += op.length;
    if (op === '<<' || op === '<<-') {
      const d = this.readDelimiter();
      if (!d) throw new ParseError('a heredoc has no delimiter');
      this.heredocs.push({ delim: d.v, strip: op === '<<-', expand: !d.quoted, owner });
      return;
    }
    const target = this.readWord();
    if (op === '<<<' && target) {
      owner.stdinText = (owner.stdinText ?? '') + target.v + '\n';
    }
  }

  // A heredoc delimiter gets quote removal only. Bash does not expand $x,
  // ${x}, or $(...) in it, so "<<\"${EOF}\"" ends at a line "${EOF}".
  readDelimiter() {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
    let v = '';
    let quoted = false;
    let any = false;
    while (this.i < this.s.length && !META.has(this.s[this.i])) {
      const c = this.s[this.i];
      any = true;
      if (c === '\\') {
        quoted = true;
        if (this.s[this.i + 1] !== undefined && this.s[this.i + 1] !== '\n') v += this.s[this.i + 1];
        this.i += 2;
        continue;
      }
      if (c === '$' && this.s[this.i + 1] === "'") {
        const tmp = newWord();
        this.readAnsiC(tmp); // $'EOF': ANSI-C quoting
        v += tmp.v;
        quoted = true;
        continue;
      }
      if (c === '$' && this.s[this.i + 1] === '"') { this.i++; continue; } // $"EOF": locale quoting
      if (c === "'") {
        const e = this.s.indexOf("'", this.i + 1);
        if (e < 0) throw new ParseError('a single quote is not closed');
        v += this.s.slice(this.i + 1, e);
        quoted = true;
        this.i = e + 1;
        continue;
      }
      if (c === '"') {
        let j = this.i + 1;
        while (j < this.s.length && this.s[j] !== '"') {
          if (this.s[j] === '\\' && '"\\$`'.includes(this.s[j + 1])) { v += this.s[j + 1]; j += 2; continue; }
          v += this.s[j];
          j++;
        }
        if (j >= this.s.length) throw new ParseError('a double quote is not closed');
        quoted = true;
        this.i = j + 1;
        continue;
      }
      v += c;
      this.i++;
    }
    return any ? { v, quoted } : null;
  }

  readWord() {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
    let w = null;
    while (this.i < this.s.length && !META.has(this.s[this.i])) {
      if (this.s[this.i] === '\\' && this.s[this.i + 1] === '\n') { this.i += 2; continue; }
      if (!w) w = newWord();
      this.readWordPart(w);
    }
    return w;
  }

  readWordPart(w) {
    const c = this.s[this.i];
    if (c === '\\') {
      if (this.i + 1 < this.s.length) { w.v += this.s[this.i + 1]; w.quoted = true; }
      this.i += 2;
      return;
    }
    if (c === "'") {
      const end = this.s.indexOf("'", this.i + 1);
      if (end < 0) throw new ParseError('a single quote is not closed');
      w.v += this.s.slice(this.i + 1, end);
      w.quoted = true;
      this.i = end + 1;
      return;
    }
    if (c === '"') { this.i++; this.readDoubleBody(w, true); w.quoted = true; return; }
    if (c === '$') {
      // An unquoted expansion can split into more words (w.split).
      const had = w.exp;
      w.exp = false;
      this.readDollar(w, false);
      if (w.exp) w.split = true;
      w.exp = w.exp || had;
      return;
    }
    if (c === '`') { this.readBacktick(w); w.split = true; return; }
    if (c === '*' || c === '?' || c === '[') w.glob = true;
    if (c === '{') w.brace = true;
    w.v += c;
    this.i++;
  }

  // Double-quoted text, or an unquoted heredoc body (needClose = false).
  readDoubleBody(w, needClose) {
    while (this.i < this.s.length) {
      const c = this.s[this.i];
      if (c === '"' && needClose) { this.i++; return; }
      if (c === '\\') {
        const n = this.s[this.i + 1];
        if (n === '\n') { this.i += 2; continue; }
        if (n !== undefined && '$`"\\'.includes(n)) { w.v += n; this.i += 2; continue; }
        w.v += c;
        this.i++;
        continue;
      }
      if (c === '$') { this.readDollar(w, true); continue; }
      if (c === '`') { this.readBacktick(w); continue; }
      w.v += c;
      this.i++;
    }
    if (needClose) throw new ParseError('a double quote is not closed');
  }

  readDollar(w, inDq) {
    const n = this.s[this.i + 1];
    if (n === '(' && this.s[this.i + 2] === '(') {
      // $(( ... )): arithmetic expansion.
      let j = this.i + 3;
      let depth = 2;
      while (j < this.s.length && depth > 0) {
        if (this.s[j] === '(') depth++;
        else if (this.s[j] === ')') depth--;
        j++;
      }
      if (depth > 0) throw new ParseError('a "$((" is not closed');
      // Arithmetic: only $(...) and `...` inside it run. Scan for them.
      new Parser(this.s.slice(this.i + 3, j - 2), this.out).readDoubleBody(newWord(), false);
      this.i = j;
      w.exp = true;
      w.v += '$((…))';
      return;
    }
    if (n === '(') { this.i += 2; this.parseList(')'); w.exp = true; w.v += '$(…)'; return; }
    if (n === '{') {
      let depth = 0;
      let j = this.i + 1;
      for (; j < this.s.length; j++) {
        if (this.s[j] === '{') depth++;
        else if (this.s[j] === '}') { depth--; if (depth === 0) break; }
      }
      if (j >= this.s.length) throw new ParseError('a "${" is not closed');
      // ${x:-$(cmd)} runs cmd. Scan the inside for substitutions.
      new Parser(this.s.slice(this.i + 2, j), this.out).readDoubleBody(newWord(), false);
      this.i = j + 1;
      w.exp = true;
      w.v += '${…}';
      return;
    }
    if (n === "'" && !inDq) { this.readAnsiC(w); return; }
    if (n === '"' && !inDq) { this.i += 2; this.readDoubleBody(w, true); w.quoted = true; return; }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = this.i + 1;
      while (j < this.s.length && /[A-Za-z0-9_]/.test(this.s[j])) j++;
      w.v += this.s.slice(this.i, j);
      w.exp = true;
      this.i = j;
      return;
    }
    if (n !== undefined && /[0-9@*#?$!-]/.test(n)) { w.v += '$' + n; w.exp = true; this.i += 2; return; }
    w.v += '$';
    this.i++;
  }

  readAnsiC(w) {
    const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v' };
    let j = this.i + 2;
    let out = '';
    while (j < this.s.length && this.s[j] !== "'") {
      if (this.s[j] === '\\' && j + 1 < this.s.length) {
        const e = this.s[j + 1];
        if (e === 'x') {
          const m = /^[0-9a-fA-F]{1,2}/.exec(this.s.substr(j + 2, 2));
          if (m) { out += String.fromCharCode(parseInt(m[0], 16)); j += 2 + m[0].length; continue; }
        }
        if (e === 'u' || e === 'U') {
          const m = (e === 'u' ? /^[0-9a-fA-F]{1,4}/ : /^[0-9a-fA-F]{1,8}/).exec(this.s.substr(j + 2, e === 'u' ? 4 : 8));
          if (m) {
            const cp = parseInt(m[0], 16);
            out += cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
            j += 2 + m[0].length;
            continue;
          }
        }
        if (e === 'c' && j + 2 < this.s.length) {
          out += String.fromCharCode(this.s.charCodeAt(j + 2) & 0x1f);
          j += 3;
          continue;
        }
        if (/[0-7]/.test(e)) {
          const m = /^[0-7]{1,3}/.exec(this.s.substr(j + 1, 3));
          out += String.fromCharCode(parseInt(m[0], 8));
          j += 1 + m[0].length;
          continue;
        }
        out += map[e] ?? e;
        j += 2;
        continue;
      }
      out += this.s[j];
      j++;
    }
    if (j >= this.s.length) throw new ParseError("a \"$'\" is not closed");
    // Bash ends the decoded text at the first NUL character.
    const nul = out.indexOf('\0');
    if (nul >= 0) out = out.slice(0, nul);
    w.v += out;
    w.quoted = true;
    this.i = j + 1;
  }

  readBacktick(w) {
    let j = this.i + 1;
    let inner = '';
    while (j < this.s.length && this.s[j] !== '`') {
      if (this.s[j] === '\\' && j + 1 < this.s.length && '`$\\'.includes(this.s[j + 1])) { inner += this.s[j + 1]; j += 2; continue; }
      inner += this.s[j];
      j++;
    }
    if (j >= this.s.length) throw new ParseError('a backtick is not closed');
    this.i = j + 1;
    new Parser(inner, this.out).parseList(null);
    w.exp = true;
    w.v += '`…`';
  }

  readHeredocBodies() {
    const pending = this.heredocs;
    this.heredocs = [];
    for (const h of pending) {
      let body = '';
      const readLine = () => {
        let e = this.s.indexOf('\n', this.i);
        const last = e < 0;
        if (last) e = this.s.length;
        const line = this.s.slice(this.i, e);
        this.i = last ? e : e + 1;
        return line;
      };
      while (this.i < this.s.length) {
        let line = readLine();
        // In an unquoted heredoc, bash joins a line that ends in an odd number
        // of backslashes with the next line before it compares the delimiter.
        if (h.expand) {
          while (/(^|[^\\])(\\\\)*\\$/.test(line) && this.i < this.s.length) line = line.slice(0, -1) + readLine();
        }
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        body += line + '\n';
      }
      if (h.owner) h.owner.stdinText = (h.owner.stdinText ?? '') + body;
      // A quoted delimiter makes the body plain data. An unquoted delimiter
      // makes $(...) and `...` in the body run.
      if (h.expand) new Parser(body, this.out).readDoubleBody(newWord(), false);
    }
  }
}

export function parseScript(src) {
  const out = [];
  new Parser(src, out).parseList(null);
  return out;
}

// ── Command resolution ───────────────────────────────────────────────────────

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const LEAD_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'coproc']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish']);
const SF_PACKAGE = /^(@salesforce\/cli|sfdx-cli|sf|sfdx)(@.*)?$/;
const SF_SCRIPT = /@salesforce[\\/]cli|sfdx-cli|[\\/]sf[\\/](bin|client)[\\/]/;
const SF_TOPIC = /^(project|deploy|data|apex|package|package1|org|api|agent|community|devops|force|sobject)(:|$)/;

// Inline-code interpreters: flag that takes code -> the guard cannot check the code.
const INTERPRETERS = {
  python: ['-c'], python3: ['-c'], python2: ['-c'], perl: ['-e', '-E'], ruby: ['-e'],
  node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'], deno: ['eval'], osascript: ['-e'], php: ['-r'],
  pwsh: ['-c', '-Command', '-command'], powershell: ['-c', '-Command', '-command'], Rscript: ['-e'],
};
const SSH_ARG_OPTS = ['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'];

// Brace expansion of one unquoted word: "{sf,x}" -> ["sf", "x"]. The budget
// bounds the total work, so "{a,b}{a,b}..." cannot take exponential time.
function expandBraces(s, budget) {
  if (budget.n >= 256) { budget.over = true; return []; }
  const m = /\{([^{}]*,[^{}]*)\}/.exec(s);
  if (!m) { budget.n++; return [s]; }
  const out = [];
  for (const alt of m[1].split(',')) {
    if (budget.over) break;
    out.push(...expandBraces(s.slice(0, m.index) + alt + s.slice(m.index + m[0].length), budget));
  }
  return out;
}

// Does a glob such as "s[f]" or "s?" match sf or sfdx?
function globMatchesSf(b) {
  if (!/[*?[]/.test(b)) return false;
  let re = '';
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = b.indexOf(']', i + 2);
      if (end < 0) { re += '\\['; continue; }
      re += '[' + b.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  try {
    const rx = new RegExp(`^${re}$`);
    return rx.test('sf') || rx.test('sfdx');
  } catch {
    return true; // unreadable pattern: treat it as sf (fail closed)
  }
}

// Is this word an sf executable name (path, zsh =sf, braces, glob)?
// w.glob / w.brace are set when the word has an UNQUOTED * ? [ or {, so
// "/path/"s[f] still counts as a glob.
function sfName(w, budget) {
  let name = w.v;
  if (name.length > 1 && name.startsWith('=')) name = name.slice(1); // zsh "=sf" expands to the sf path
  const variants = w.brace ? expandBraces(name, budget) : [name];
  return variants.some((n) => {
    const b = n.split('/').pop();
    if (b === 'sf' || b === 'sfdx') return true;
    if (!w.glob) return false;
    if (/[@?*+!]\(/.test(b)) {
      // Extended glob: try each alternative of a simple @(a|b) group.
      const m = /^([^()]*)[@?*+!]\(([^()]*)\)([^()]*)$/.exec(b);
      if (!m) return true; // nested or complex pattern: fail closed
      return m[2].split('|').some((alt) => {
        const t = m[1] + alt + m[3];
        return t === 'sf' || t === 'sfdx' || globMatchesSf(t);
      }) || b.startsWith('!(');
    }
    return globMatchesSf(b);
  });
}

// Skip option words. withArg lists options that take the next word as a value.
function skipOpts(ws, k, withArg = []) {
  while (k < ws.length) {
    const v = ws[k].v;
    if (v === '--') return k + 1;
    if (!v.startsWith('-') || v === '-') return k;
    if (withArg.includes(v)) k += 2;
    else k++;
  }
  return k;
}

// Code given to an interpreter option: -c CODE, -cCODE, --eval=CODE,
// --eval CODE, or a cluster that ends in the option letter (-Bc CODE).
function codeTexts(ws, k, codeFlags) {
  const out = [];
  for (let j = k + 1; j < ws.length; j++) {
    const v = ws[j].v;
    for (const f of codeFlags) {
      if (v === f) { if (j + 1 < ws.length) out.push(ws[j + 1].v); break; }
      if (f.startsWith('--') && v.startsWith(`${f}=`)) { out.push(v.slice(f.length + 1)); break; }
      if (/^-[A-Za-z]$/.test(f) && /^-[A-Za-z]/.test(v) && !v.startsWith('--') && v.length > 2) {
        const at = v.indexOf(f[1]);
        if (at > 0) {
          const rest = v.slice(at + 1);
          out.push(rest || (ws[j + 1]?.v ?? ''));
          break;
        }
      }
    }
  }
  return out;
}

// Commands that only read or print their arguments. The generic wrapper
// fallback does not look inside them.
const DATA_COMMANDS = new Set([
  'echo', 'printf', 'print', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'head', 'tail',
  'git', 'gh', 'jq', 'yq', 'sed', 'awk', 'tee', 'wc', 'sort', 'uniq', 'cut', 'tr', 'man', 'which', 'type',
  'whereis', 'whatis', 'apropos', 'test', '[', '[[', 'read', 'true', 'false', 'ls', 'pbcopy', 'diff', 'cmp',
]);

// Find the sf argv in one simple command.
// Returns null, or { argv, via } where via = { sudo, xargs }:
//   sudo:  runs as another user, with other sf logins.
//   xargs: more arguments come from input.
// Side effects on ctx:
//   ctx.assigns: NAME=value words that set the environment.
//   ctx.nested:  { text, via } shell text that runs (bash -c, eval, bash <<EOF).
//   ctx.subs:    { ws, via } word lists that run (find -exec).
//   ctx.opaque:  commands whose name contains a shell expansion.
//   ctx.foreign: inline code (python -c, node -e, osascript -e), ssh/su
//                commands, and shells that read a script from a pipe. The
//                guard cannot check these.
function findSf(ws, ctx, via0) {
  const via = { sudo: false, xargs: false, ...via0 };
  const nest = (text) => ctx.nested.push({ text, via: { ...via } });
  const budget = { n: 0, over: false };
  const splitEnv = (text, after) => {
    // GNU env -S has its own escapes (\_ is a space, \c, ${VAR}) that Bash
    // syntax does not have. The guard cannot read them. Treat them as opaque.
    if (/[\\$]/.test(text)) { ctx.opaque.push({ name: 'env -S', sfArgs: true }); return null; }
    let words;
    try { words = parseScript(text)[0] ?? []; } catch { nest(text); return null; }
    return findSf([...words, ...after], ctx, via);
  };
  let k = 0;
  for (let guard = 0; guard < 64 && k < ws.length; guard++) {
    while (k < ws.length && ASSIGN.test(ws[k].v)) { ctx.assigns.push(ws[k].v); k++; }
    if (k >= ws.length) return null;
    const w = ws[k];
    const name = w.v;
    if (!w.quoted && LEAD_KEYWORDS.has(name)) { k++; continue; }
    if (!w.quoted && name === '-') { k++; continue; } // zsh "-" precommand modifier
    if (!w.quoted && name === 'function') { k += 2; continue; } // function NAME { ...; }
    if (sfName(w, budget)) return { argv: ws.slice(k + 1), via };
    if (budget.over) {
      ctx.opaque.push({ name: name.slice(0, 40), sfArgs: true });
      return null;
    }
    const base = name.split('/').pop();
    if (INTERPRETERS[base]) {
      for (const text of codeTexts(ws, k, INTERPRETERS[base])) ctx.foreign.push({ name: base, text });
      if (base !== 'node' && base !== 'nodejs' && base !== 'deno') return null;
    }
    switch (base) {
      case 'export': case 'declare': case 'typeset': case 'local': case 'readonly':
        for (const x of ws.slice(k + 1)) if (ASSIGN.test(x.v)) ctx.assigns.push(x.v);
        return null;
      case 'env':
        k++;
        while (k < ws.length) {
          const v = ws[k].v;
          // env -S TEXT ARGS...: TEXT splits into words; ARGS stay separate words.
          if (v === '-S' || v === '--split-string') return splitEnv(ws[k + 1]?.v ?? '', ws.slice(k + 2));
          if (v.startsWith('--split-string=')) return splitEnv(v.slice(15), ws.slice(k + 1));
          if (/^-[A-Za-z]*S/.test(v)) {
            const rest = v.slice(v.indexOf('S') + 1);
            return rest ? splitEnv(rest, ws.slice(k + 1)) : splitEnv(ws[k + 1]?.v ?? '', ws.slice(k + 2));
          }
          if (['-u', '--unset', '-C', '--chdir', '-P', '-a', '--argv0'].includes(v)) k += 2;
          else if (v === '--') { k++; break; }
          else if (v.startsWith('-')) k++;
          else if (ASSIGN.test(v)) { ctx.assigns.push(v); k++; }
          else break;
        }
        continue;
      case 'command': {
        // Only the options directly after "command" count. "command -v sf" prints a path.
        const end = skipOpts(ws, k + 1);
        const opts = ws.slice(k + 1, end).map((x) => x.v).filter((v) => v !== '--').join('');
        if (/[vV]/.test(opts)) return null;
        k = end;
        continue;
      }
      case 'script': {
        // macOS: script [-aeFkqr] [-t time] [file [command ...]]. Linux: script -c CMD / -qc CMD.
        let j = k + 1;
        while (j < ws.length && ws[j].v.startsWith('-')) {
          const v = ws[j].v;
          if (v === '--command') { nest(ws[j + 1]?.v ?? ''); return null; }
          if (v.startsWith('--command=')) { nest(v.slice(10)); return null; }
          if (v.startsWith('--')) { j++; continue; }
          // Short option cluster. -c takes the rest of the word or the next word
          // (-qc'CMD', -qc CMD). Options with a value end the cluster.
          let step = 1;
          for (let x = 1; x < v.length; x++) {
            if (v[x] === 'c') { nest(v.slice(x + 1) || (ws[j + 1]?.v ?? '')); return null; }
            if ('tTEIOBmo'.includes(v[x])) { if (x === v.length - 1) step = 2; break; }
          }
          j += step;
        }
        k = j + 1; // skip the typescript file; the rest is the command
        continue;
      }
      case 'ssh': {
        // The remote command runs on another machine with its own sf logins.
        const j = skipOpts(ws, k + 1, SSH_ARG_OPTS);
        const remote = ws.slice(j + 1).map((x) => x.v).join(' ');
        if (remote) ctx.foreign.push({ name: 'ssh', text: remote });
        return null;
      }
      case 'su':
        // su runs a command as another user, with that user's sf logins.
        ctx.foreign.push({ name: 'su', text: ws.slice(k + 1).map((x) => x.v).join(' ') });
        return null;
      case 'builtin': case 'nohup': case 'noglob': case 'nocorrect': case 'setsid': case 'unbuffer':
      case 'dbus-run-session': case 'caffeinate':
        k = skipOpts(ws, k + 1, ['-t', '-w']);
        continue;
      case 'time': // shell keyword, BSD time, and GNU time (-f FORMAT, -o FILE)
        k = skipOpts(ws, k + 1, ['-f', '-o', '--format', '--output']);
        continue;
      case 'exec':
        k = skipOpts(ws, k + 1, ['-a']);
        continue;
      case 'sudo': case 'doas':
        via.sudo = true;
        k = skipOpts(ws, k + 1, ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group', '--chdir', '--prompt']);
        continue;
      case 'nice':
        k = skipOpts(ws, k + 1, ['-n', '--adjustment']);
        continue;
      case 'ionice':
        k = skipOpts(ws, k + 1, ['-c', '-n', '-p', '-P', '-u', '--class', '--classdata']);
        continue;
      case 'stdbuf':
        k = skipOpts(ws, k + 1, ['-i', '-o', '-e']);
        continue;
      case 'chrt': case 'taskset':
        k = skipOpts(ws, k + 1);
        k++; // priority or CPU mask
        continue;
      case 'arch':
        k = skipOpts(ws, k + 1, ['-arch', '-e', '-d']);
        continue;
      case 'sandbox-exec':
        k = skipOpts(ws, k + 1, ['-f', '-n', '-p', '-D']);
        continue;
      case 'flock': {
        // flock [options] FILE COMMAND... or flock [options] FILE -c COMMAND
        let j = skipOpts(ws, k + 1, ['-w', '--timeout', '-E', '--conflict-exit-code']);
        j++; // lock file
        if (ws[j]?.v === '-c' || ws[j]?.v === '--command') { nest(ws[j + 1]?.v ?? ''); return null; }
        k = j;
        continue;
      }
      case 'timeout': case 'gtimeout':
        k = skipOpts(ws, k + 1, ['-s', '--signal', '-k', '--kill-after']);
        k++; // duration
        continue;
      case 'xargs':
        via.xargs = true;
        k = skipOpts(ws, k + 1, ['-n', '-L', '-P', '-I', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']);
        continue;
      case 'parallel': {
        via.xargs = true;
        k = skipOpts(ws, k + 1, ['-j', '--jobs', '-N', '-n', '-S', '--sshlogin', '-a', '--arg-file', '--delay', '--timeout']);
        const sep = ws.findIndex((x, i) => i >= k && (x.v === ':::' || x.v === '::::'));
        if (sep >= 0) ws = ws.slice(0, sep);
        continue;
      }
      case 'watch': {
        const end = skipOpts(ws, k + 1, ['-n', '--interval', '-q', '--equexit']);
        const argvMode = ws.slice(k + 1, end).some((x) => x.v === '--exec' || /^-[A-Za-z]*x/.test(x.v));
        k = end;
        if (argvMode) continue; // watch -x CMD ARGS: runs CMD directly
        nest(ws.slice(k).map((x) => x.v).join(' ')); // watch CMD: runs "sh -c" with the joined text
        return null;
      }
      case 'npx': case 'bunx': case 'pnpx':
        k++;
        while (k < ws.length && ws[k].v.startsWith('-')) {
          const v = ws[k].v;
          if (v === '-c' || v === '--call') { nest(ws[k + 1]?.v ?? ''); return null; }
          if (v.startsWith('--call=')) { nest(v.slice(7)); return null; }
          if (v === '-p' || v === '--package') { k += 2; continue; }
          if (v === '--') { k++; break; }
          k++;
        }
        if (k < ws.length && SF_PACKAGE.test(ws[k].v)) return { argv: ws.slice(k + 1), via };
        continue;
      case 'npm': case 'pnpm': case 'yarn': case 'bun':
        if (['exec', 'x', 'dlx'].includes(ws[k + 1]?.v)) {
          k += 2;
          while (k < ws.length && ws[k].v.startsWith('-')) {
            const v = ws[k].v;
            if (v === '-c' || v === '--call') { nest(ws[k + 1]?.v ?? ''); return null; }
            if (v.startsWith('--call=')) { nest(v.slice(7)); return null; }
            if (v === '-p' || v === '--package') { k += 2; continue; }
            if (v === '--') { k++; break; }
            k++;
          }
          if (k < ws.length && SF_PACKAGE.test(ws[k].v)) return { argv: ws.slice(k + 1), via };
          continue;
        }
        return null; // npm run <script>: the guard cannot see inside scripts.
      case 'node': case 'nodejs': case 'deno':
        k = skipOpts(ws, k + 1, ['-r', '--require', '--import', '--loader']);
        if (k < ws.length && SF_SCRIPT.test(ws[k].v)) return { argv: ws.slice(k + 1), via };
        return null;
      case 'eval':
        nest(ws.slice(k + 1).map((x) => x.v).join(' '));
        return null;
      case 'awk': case 'gawk': case 'mawk': case 'nawk': {
        // awk can run commands: system(), getline from a command, print | "cmd".
        const text = ws.slice(k + 1).map((x) => x.v).join(' ');
        if (/\bsystem\s*\(|\bgetline\b|\|&|\bprintf?\b[^;}\n]*\|/.test(text)) ctx.foreign.push({ name: base, text });
        return null;
      }
      case 'sed': case 'gsed': {
        // GNU sed runs commands with the "e" command and the s///e flag.
        const text = ws.slice(k + 1).map((x) => x.v).join('\n');
        if (/(^|[;{}\n]|[0-9$\/])\s*e\b|\/[gpiImM0-9w]*e[gpiImM0-9]*\s*($|[;}\n])/.test(text)) ctx.foreign.push({ name: base, text });
        return null;
      }
      case 'git': {
        // git -c alias.x='!cmd', core.pager, core.sshCommand, and others run commands.
        for (let j = k + 1; j < ws.length; j++) {
          const v = ws[j].v;
          if (v === '-c' || v === '--config-env') { if (ws[j + 1]) ctx.foreign.push({ name: 'git -c', text: ws[j + 1].v }); j++; continue; }
          if (v.startsWith('-c') && v.length > 2) { ctx.foreign.push({ name: 'git -c', text: v.slice(2) }); continue; }
          if (v.startsWith('--config-env=')) { ctx.foreign.push({ name: 'git -c', text: v.slice(13) }); continue; }
          if (['-C', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(v)) { j++; continue; }
          if (!v.startsWith('-')) break; // the git subcommand: the rest is its arguments
        }
        return null;
      }
      case 'find': {
        for (let j = k + 1; j < ws.length; j++) {
          if (['-exec', '-execdir', '-ok', '-okdir'].includes(ws[j].v)) {
            let e = j + 1;
            while (e < ws.length && ws[e].v !== ';' && ws[e].v !== '+') e++;
            ctx.subs.push({ ws: ws.slice(j + 1, e), via: { ...via } });
            j = e;
          }
        }
        return null;
      }
      default:
        if (SHELLS.has(base)) {
          shellRuns(ws, k, base, ctx, nest);
          return null;
        }
        if (w.exp) {
          // The command name comes from an expansion, e.g. $C, $(which sf), s${X:-f}.
          ctx.opaque.push({ name, sfArgs: ws.slice(k + 1, k + 4).some((x) => SF_TOPIC.test(x.v)) });
          return null;
        }
        // Unknown wrapper (setsid-like tools the guard does not list): if a
        // later word is sf followed by an sf topic, treat it as an sf call.
        if (!DATA_COMMANDS.has(base)) {
          for (let j = k + 1; j < ws.length - 1; j++) {
            if (sfName(ws[j], { n: 0, over: false }) && SF_TOPIC.test(ws[j + 1].v)) return { argv: ws.slice(j + 1), via };
          }
        }
        return null;
    }
  }
  if (k < ws.length) ctx.tooDeep = true; // wrapper limit reached before the command name
  return null;
}

// What does "bash ..." run? -c TEXT, a script file, or stdin.
function shellRuns(ws, k, base, ctx, nest) {
  let j = k + 1;
  let hasC = false;
  let fromStdin = false;
  let noexec = false;
  while (j < ws.length) {
    const v = ws[j].v;
    if (v === '--') { j++; break; }
    if (v === '--rcfile' || v === '--init-file') { j += 2; continue; }
    if (v.startsWith('--')) { j++; continue; }
    if (/^[-+][A-Za-z]+$/.test(v)) {
      const on = v[0] === '-';
      let takesArg = 0;
      for (const ch of v.slice(1)) {
        if (ch === 'o' || ch === 'O') {
          takesArg++;
          const arg = ws[j + takesArg]?.v;
          if (ch === 'o' && arg === 'noexec') noexec = on;
        } else if (ch === 'c' && on) hasC = true;
        else if (ch === 's' && on) fromStdin = true;
        else if (ch === 'n') noexec = on;
      }
      j += 1 + takesArg;
      continue;
    }
    break;
  }
  if (noexec) return; // bash -n only checks syntax
  if (hasC) { if (j < ws.length) nest(ws[j].v); return; }
  if (j < ws.length && !fromStdin) return; // bash script.sh: the guard cannot see inside scripts.
  // The shell reads its script from stdin: a heredoc, a here-string, or a pipe.
  if (ws.stdinText !== undefined) nest(ws.stdinText);
  else ctx.foreign.push({ name: `${base} reading a script from a pipe`, text: ctx.command });
}

// ── sf command analysis ──────────────────────────────────────────────────────

// Table format 2: commands[id] = { org, hub, args, flags: { spelling: [name, isBoolean] } },
// aliases[alias] = id. Returns a Map from id or alias to { id, ...entry }.
export function loadCommandTable(file = path.join(HERE, 'sf-command-table.json')) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    const m = new Map();
    for (const [id, e] of Object.entries(data.commands)) m.set(id, { id, ...e });
    for (const [a, id] of Object.entries(data.aliases ?? {})) if (!m.has(a) && m.has(id)) m.set(a, m.get(id));
    // sf (oclif flexible taxonomy) also accepts the command words in another
    // order, e.g. "sf delete org sandbox". Index by the sorted words.
    // A sorted key that fits two commands is marked ambiguous (null).
    m.permutations = new Map();
    for (const id of Object.keys(data.commands)) {
      const key = id.split(':').sort().join(':');
      m.permutations.set(key, m.permutations.has(key) && m.permutations.get(key) !== id ? null : id);
    }
    return m;
  } catch {
    const m = new Map();
    m.failed = true; // analyzeSf blocks every sf command
    return m;
  }
}

const block = (reason) => ({ kind: 'block', reason });
const pretty = (id) => `sf ${id.replace(/:/g, ' ')}`;

// Parse sf arguments the way oclif does, with the flag arity from the table.
// A value flag takes the next word even when that word starts with "-".
// Returns values: Map(name -> [word]), bools: Set(name), problems: [text].
function parseSfArgv(argv, flags) {
  const values = new Map();
  const bools = new Set();
  const problems = [];
  const add = (name, w) => values.set(name, [...(values.get(name) ?? []), w]);
  // A separate value word with an unquoted expansion can split into more
  // words, for example --wait ${W:-5 --use-most-recent}. Block it.
  const takeValue = (flag, name, w) => {
    if (w.split) problems.push(`the value of ${flag} contains an unquoted shell expansion that can split into more arguments`);
    add(name, w);
  };
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    const v = w.v;
    if (v === '--') break;
    if (w.exp) {
      problems.push(`the word "${v}" contains a shell expansion where sf reads a flag or argument`);
      continue;
    }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      const key = eq > 0 ? v.slice(0, eq) : v;
      const def = flags[key];
      if (!def) { problems.push(`the flag ${key} is not in the guard command table`); continue; }
      const [name, isBool] = def;
      if (isBool) { bools.add(name); continue; }
      if (eq > 0) { add(name, { v: v.slice(eq + 1), exp: false }); continue; }
      if (i + 1 >= argv.length) { problems.push(`the flag ${key} has no value`); continue; }
      takeValue(key, name, argv[++i]);
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      // -o value, -ovalue, -o=value, or a cluster such as -rw5 (= -r -w 5).
      for (let j = 1; j < v.length; j++) {
        const def = flags[`-${v[j]}`];
        if (!def) { problems.push(`the flag -${v[j]} (in "${v}") is not in the guard command table`); break; }
        const [name, isBool] = def;
        if (isBool) { bools.add(name); continue; }
        const rest = v.slice(j + 1).replace(/^=/, '');
        if (rest) add(name, { v: rest, exp: false });
        else if (i + 1 < argv.length) takeValue(`-${v[j]}`, name, argv[++i]);
        else problems.push(`the flag -${v[j]} has no value`);
        break;
      }
    }
    // Other words are positional arguments.
  }
  return { values, bools, problems };
}

// A value must be literal. An unquoted expansion can also split into more words.
function literalValues(words, flag) {
  const out = [];
  for (const w of words ?? []) {
    if (w.exp) return { error: `The value of ${flag} contains a shell expansion. Write the literal value.` };
    out.push(w.v);
  }
  return { values: out };
}

// Orgs that deploy quick / deploy cancel take from ~/.sf/deploy-cache.json
// before --target-org (plugin-deploy-retrieve quick.js and cancel.js).
function cacheOrgTargets(jobIds, mostRecent) {
  let cache = {};
  try {
    cache = JSON.parse(readFileSync(path.join(os.homedir(), '.sf', 'deploy-cache.json'), 'utf8')) || {};
  } catch { /* no cache: sf uses --target-org */ }
  const targets = [];
  const add = (entry) => { if (entry && typeof entry['target-org'] === 'string') targets.push(entry['target-org']); };
  for (const jobId of jobIds) {
    if (jobId.length === 18) add(cache[jobId]);
    else if (jobId.length === 15) for (const [key, val] of Object.entries(cache)) if (key.startsWith(jobId)) add(val);
  }
  if (mostRecent) {
    let latest = null;
    for (const val of Object.values(cache)) {
      const t = Date.parse(val?.timestamp ?? '');
      if (!Number.isNaN(t) && (!latest || t > latest.t)) latest = { t, val };
    }
    add(latest?.val);
  }
  return targets;
}

const LEGACY_TARGET_FLAGS = ['--target-org', '--targetusername', '-o', '-u'];
const isShortCluster = (v) => v.length > 2 && v[0] === '-' && v[1] !== '-';

// For commands that are not in the table: scan for the usual org flags.
function legacyTargets(argv) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    const w = argv[i];
    const v = w.v;
    if (v === '--') break;
    if (w.exp) return { error: `The word "${v}" contains a shell expansion. Write the sf command literally.` };
    if (v === '--flags-dir' || v.startsWith('--flags-dir=')) return { error: 'A flags directory can change the org. Remove --flags-dir.' };
    let matched = false;
    for (const name of LEGACY_TARGET_FLAGS) {
      if (v === name) {
        const nx = argv[i + 1];
        if (!nx || nx.exp) return { error: `The flag ${name} has no literal value.` };
        values.push(nx.v);
        i++;
        matched = true;
        break;
      }
      if (v.startsWith(`${name}=`) || (name.length === 2 && v.startsWith(name) && v.length > 2)) {
        values.push(v.slice(name.length).replace(/^=/, ''));
        matched = true;
        break;
      }
    }
    if (!matched && isShortCluster(v) && /[ou]/.test(v.slice(2))) {
      return { error: `The word "${v}" can combine short flags with an org flag. Write each flag separately.` };
    }
  }
  return { values };
}

// Dev Hub commands that change packaging state that cannot be restored
// (promote, delete) or that affect subscriber orgs (push upgrade abort).
// The guard checks the Dev Hub org like a target org. Scratch org commands and
// package create / beta version commands stay allowed: scratch org development
// needs them, and Dev Hubs are usually production orgs.
export const DEVHUB_WRITES = new Set([
  'package:version:promote', 'package:delete', 'package:version:delete',
  'package:update', 'package:version:update', 'package:push-upgrade:abort',
]);
const CACHE_ORG_COMMANDS = new Set(['project:deploy:quick', 'project:deploy:cancel']);

function needTargets(id, targets, flagName, known) {
  const uniq = [...new Set(targets)];
  if (!uniq.length) {
    const what = known ? 'can change an org' : 'is not in the guard command table, so the guard treats it as a write';
    return block(`"${pretty(id)}" ${what}. Add an explicit ${flagName} <alias>. The guard does not use the default org, SF_TARGET_ORG, or config values.`);
  }
  return { kind: 'check', id, targets: uniq };
}

// The sf CLI (dist/flags.js preprocessCliFlags) removes --dev-debug, and the
// first --debug-filter with the word after it, before oclif reads argv.
// Do the same, so that "--debug-filter -h" is not read as a help request.
function preprocessCliFlags(argv) {
  const a = [...argv];
  let unsafe = false;
  a.map((w) => {
    if (w.v === '--dev-debug') {
      const fi = a.findIndex((x) => x.v === '--debug-filter');
      if (fi >= 0) {
        if (a[fi + 1]?.split) unsafe = true;
        a.splice(fi, 2);
      }
      a.splice(a.findIndex((x) => x.v === '--dev-debug'), 1);
    }
  });
  return { argv: a, unsafe };
}

export function analyzeSf(argv0, table) {
  const pre = preprocessCliFlags(argv0);
  if (pre.unsafe) return block('The value of --debug-filter contains an unquoted shell expansion. Write it literally.');
  const argv = pre.argv;
  const dd = argv.findIndex((w) => w.v === '--');
  const flagPart = dd < 0 ? argv : argv.slice(0, dd);
  if (flagPart.some((w) => !w.exp && (w.v === '--help' || w.v === '-h'))) return { kind: 'allow', help: true };

  // sf removes some flags (for example --dev-debug) before it reads the
  // command id. Skip leading flags so they cannot hide the command.
  let s = 0;
  while (s < argv.length && argv[s].v.startsWith('-') && argv[s].v !== '--') s++;
  const idWords = [];
  for (const w of argv.slice(s)) {
    if (w.v.startsWith('-')) break;
    if (w.exp) return block('The sf command name contains a shell expansion. Write the sf command literally.');
    idWords.push(w.v.split(':').filter(Boolean));
  }
  const tokens = idWords.flat();
  if (!tokens.length) return { kind: 'allow' }; // sf, sf --version
  if (table.failed || !table.size) {
    return block('The guard cannot load sf-command-table.json, so it cannot classify sf commands. Run install.sh again.');
  }

  // Longest known command id that ends on a word boundary. "org:list:purge"
  // must not match "org:list". Extra words are positional arguments only if
  // the command takes them; otherwise they can be an unknown subcommand.
  let entry = null;
  let used = 0;
  for (let nWords = idWords.length; nWords > 0 && !entry; nWords--) {
    const words = idWords.slice(0, nWords).flat();
    let e = table.get(words.join(':'));
    if (!e && table.permutations) {
      const pid = table.permutations.get([...words].sort().join(':'));
      if (pid) e = table.get(pid);
    }
    if (e && (nWords === idWords.length || e.args)) { entry = e; used = nWords; }
  }
  const id = entry ? entry.id : tokens.join(':');
  const rest = argv.slice(s + used);

  if (ALWAYS_BLOCK.has(id)) return block(`"${pretty(id)}" is not permitted from Claude Code. ${ALWAYS_BLOCK.get(id)} Run it from DevOps Center, CI, or a terminal outside Claude Code.`);
  if (LOCAL_STATE.test(id)) return { kind: 'allow', mutatesState: true, id };
  if (READ_ONLY.has(id)) return { kind: 'allow', id };
  if (entry && !entry.org && !DEVHUB_WRITES.has(id)) return { kind: 'allow', id }; // local, Dev Hub read, scratch org

  if (!entry) {
    const t = legacyTargets(rest);
    if (t.error) return block(`"${pretty(id)}": ${t.error}`);
    return needTargets(id, t.values, '--target-org', false);
  }

  const p = parseSfArgv(rest, entry.flags);
  if (p.problems.length) {
    return block(`"${pretty(id)}": the guard cannot read the arguments (${p.problems.join('; ')}). Write every flag and value literally, or run "node guard/gen-sf-command-table.mjs" after an sf upgrade.`);
  }
  if (p.values.has('flags-dir')) return block(`"${pretty(id)}" uses --flags-dir. A flags directory can change the org or other flags. Remove --flags-dir.`);

  // No exemption for "sf api request rest": a GET can also change the org
  // (for example GET /tooling/executeAnonymous runs Apex).

  if (DEVHUB_WRITES.has(id)) {
    const t = literalValues(p.values.get('target-dev-hub'), '--target-dev-hub');
    if (t.error) return block(`"${pretty(id)}": ${t.error}`);
    return needTargets(id, t.values, '--target-dev-hub', true);
  }

  const t = literalValues(p.values.get('target-org'), '--target-org');
  if (t.error) return block(`"${pretty(id)}": ${t.error}`);
  let targets = t.values;
  if (CACHE_ORG_COMMANDS.has(id)) {
    const j = literalValues(p.values.get('job-id'), '--job-id');
    if (j.error) return block(`"${pretty(id)}": ${j.error}`);
    targets = [...cacheOrgTargets(j.values, p.bools.has('use-most-recent')), ...targets];
    const r = needTargets(id, targets, '--target-org', true);
    if (r.kind === 'check') r.usesCache = true;
    return r;
  } else if (new Set(targets).size > 1) {
    return block(`"${pretty(id)}" names more than one org (${[...new Set(targets)].join(', ')}). Give exactly one --target-org.`);
  }
  return needTargets(id, targets, '--target-org', true);
}

const looksSalesforce = (text) => /\bsf(dx)?\b|salesforce/i.test(text.replace(/['"\\]/g, ''));

// Static analysis of the whole Bash command. No org access.
export function analyze(command, table) {
  const results = [];
  const ctx = { command, assigns: [], nested: [], subs: [], opaque: [], foreign: [] };
  const queue = []; // items: { ws, via }
  const parseInto = (text, via) => {
    try {
      queue.push(...parseScript(text).map((ws) => ({ ws, via })));
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      // The raw text can hide an sf call in an expansion or in $'\x73\x66'.
      // After a parse failure, block those too.
      if (looksSalesforce(text) || /[$`]/.test(text)) results.push(block(`The guard cannot parse the command (${e.message}). Fix the shell syntax, or run the sf command as a separate, simple command.`));
    }
  };
  parseInto(command, {});
  let qi = 0;
  for (let budget = 5000; qi < queue.length && budget > 0; budget--) {
    const item = queue[qi++];
    const found = findSf(item.ws, ctx, item.via);
    if (found) {
      const r = analyzeSf(found.argv, table);
      if (found.via.xargs && r.kind !== 'block' && !r.help) {
        // xargs / parallel add arguments from their input. Allow only a
        // complete read-only or local command that more words cannot extend.
        const extendable = r.id === undefined || [...table.keys()].some((key) => key.startsWith(`${r.id}:`));
        if (r.kind === 'check' || extendable) {
          results.push(block('xargs or parallel adds arguments to the sf command from its input, so the guard cannot see the full command. Run sf directly with all arguments written out.'));
        } else results.push(r);
      } else if (found.via.sudo && r.kind === 'check') {
        results.push(block(`sudo runs "${pretty(r.id)}" as another user, with that user's org logins. The guard cannot check them.`));
      } else results.push(r);
    }
    while (ctx.nested.length) { const n = ctx.nested.shift(); parseInto(n.text, n.via); }
    while (ctx.subs.length) queue.push(ctx.subs.shift());
  }
  if (qi < queue.length) results.push(block('The command is too complex for the guard to check. Split it into simpler commands.'));
  if (ctx.tooDeep && looksSalesforce(command)) results.push(block('The command has too many wrapper commands for the guard to check. Run sf directly.'));
  // A command name that contains an expansion ($C, eval "$C", s${X:-f}) can
  // hide an sf call. Block it when the arguments or the script look like Salesforce.
  for (const o of ctx.opaque) {
    if (o.sfArgs || looksSalesforce(command)) {
      results.push(block(`The command name "${o.name}" contains a shell expansion, and the command can be a Salesforce command. Write the sf command literally.`));
    }
  }
  for (const f of ctx.foreign) {
    if (looksSalesforce(f.text)) {
      results.push(block(`The command runs ${f.name} code that mentions Salesforce. The guard cannot check it. Run the sf command directly in Bash.`));
    }
  }
  const checks = results.filter((r) => r.kind === 'check');
  // deploy quick / cancel read their org from the deploy cache. Another
  // deploy command in the same call (start, validate, resume, report) can
  // change that cache after the guard reads it.
  const sfResults = results.filter((r) => r.kind !== 'block');
  if (checks.some((r) => r.usesCache) && sfResults.some((r) => !r.usesCache && /^project:deploy:/.test(r.id ?? ''))) {
    results.push(block('The command runs "sf project deploy quick" or "cancel" together with another deploy command. The other command can change the deploy cache that quick and cancel read their org from. Run quick or cancel as a separate Bash command.'));
  }
  if (checks.filter((r) => r.usesCache).length > 1) {
    results.push(block('The command runs more than one "sf project deploy quick" or "cancel". Each one can change the deploy cache. Run them as separate Bash commands.'));
  }
  if (checks.length) {
    if (results.some((r) => r.mutatesState)) {
      results.push(block('The command changes an org alias, login, or sf config, and also runs a command that changes an org. Run the alias, login, or config change as a separate Bash command first.'));
    }
    const sensitive = [...new Set(ctx.assigns.map((a) => a.split('=')[0]).filter(isSensitiveEnv))];
    if (sensitive.length) {
      results.push(block(`The command sets ${sensitive.join(', ')} and also runs a command that changes an org. These variables can change which org sf uses. Remove them.`));
    }
  }
  return results;
}

// ── Org classification ───────────────────────────────────────────────────────

function findSfBin() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  const candidates = [
    ...dirs.map((d) => path.join(d, 'sf')),
    '/opt/homebrew/bin/sf', '/usr/local/bin/sf', '/usr/local/lib/sf/bin/sf',
    path.join(home, '.local/share/sf/client/bin/sf'), path.join(home, '.local/share/sf/bin/sf'),
    path.join(home, '.volta/bin/sf'),
  ];
  try {
    const nvm = path.join(home, '.nvm/versions/node');
    for (const v of readdirSync(nvm)) candidates.push(path.join(nvm, v, 'bin/sf'));
  } catch { /* no nvm */ }
  return candidates.find((c) => { try { return statSync(c).isFile(); } catch { return false; } }) ?? null;
}

export function loadAllowlist(file = path.join(HERE, 'allowed-orgs.json')) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { entries: [], problems: [] };
    return { entries: [], problems: [`allowed-orgs.json is not valid JSON: ${e.message}`] };
  }
  const entries = [];
  const problems = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const e of Array.isArray(data?.orgs) ? data.orgs : []) {
    if (typeof e?.orgId !== 'string' || !/^00D[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/.test(e.orgId)) {
      problems.push(`allowed-orgs.json has an entry with a bad orgId: ${JSON.stringify(e?.orgId)}`);
      continue;
    }
    // expires is required and must be a real calendar date.
    const real = typeof e.expires === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.expires) &&
      !Number.isNaN(Date.parse(`${e.expires}T00:00:00Z`)) &&
      new Date(`${e.expires}T00:00:00Z`).toISOString().slice(0, 10) === e.expires;
    if (!real) {
      problems.push(`allowed-orgs.json entry ${e.orgId} has no valid expires date. Use a real date in YYYY-MM-DD format.`);
      continue;
    }
    if (e.expires < today) {
      problems.push(`allowed-orgs.json entry ${e.orgId} (${e.label ?? 'no label'}) expired on ${e.expires}.`);
      continue;
    }
    entries.push(e);
  }
  return { entries, problems };
}

// Runs the Organization query in its own process group. On timeout the guard
// kills the whole group with SIGKILL, so a child that ignores SIGTERM, or a
// grandchild that holds the pipe open, cannot keep the hook waiting.
function queryOrg(sfBin, target, cwd) {
  const remaining = TOTAL_BUDGET_MS - (Date.now() - START);
  if (remaining < 3000) return Promise.resolve({ error: 'the guard ran out of time before it could check this org' });
  const env = {
    ...process.env,
    PATH: [path.dirname(process.execPath), process.env.PATH || ''].join(path.delimiter),
    SF_DISABLE_AUTOUPDATE: 'true',
    SF_AUTOUPDATE_DISABLE: 'true',
    SF_SKIP_NEW_VERSION_CHECK: 'true',
    SF_DISABLE_TELEMETRY: 'true',
    SF_JSON_TO_STDOUT: 'true',
  };
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(sfBin, ['data', 'query', '--query', ORG_SOQL, '--target-org', target, '--json'], {
        cwd, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (e) {
      finish({ error: `sf could not start (${e.message})` });
      return;
    }
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      finish({ error: 'the org query did not finish in time' });
    }, Math.min(QUERY_TIMEOUT_MS, remaining - 1000));
    child.on('error', (e) => finish({ error: `sf could not start (${e.message})` }));
    child.stdout.on('data', (d) => { if (out.length < 10 * 1024 * 1024) out += d; });
    child.on('close', (code) => {
      let j;
      try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch { /* not JSON */ }
      if (code !== 0) {
        finish({ error: j ? `sf returned an error: ${j.name ?? ''} ${j.message ?? ''}`.trim() : `sf failed (exit ${code})` });
        return;
      }
      const rec = j?.result?.records?.[0];
      if (!rec || typeof rec.Id !== 'string') finish({ error: j ? 'the Organization query returned no record' : 'the Organization query did not return JSON' });
      else finish({ rec });
    });
  });
}

export function classify(rec, allowlist) {
  const hit = allowlist.entries.find((e) => e.orgId.slice(0, 15) === rec.Id.slice(0, 15));
  if (hit) return { ok: true, why: `allowlisted ${hit.kind ?? 'org'} (${hit.label ?? hit.orgId})` };
  if (rec.IsSandbox === true) return { ok: true, why: 'sandbox' };
  if (DEV_EDITION_TYPES.has(rec.OrganizationType)) return { ok: true, why: rec.OrganizationType };
  if (rec.TrialExpirationDate) return { ok: true, why: `trial or scratch org (expires ${rec.TrialExpirationDate})` };
  return { ok: false };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export function deny(lines) {
  const msg = ['ka-vault guard: BLOCKED.', ...lines,
    'Production orgs are never a permitted target from Claude Code. Use a CI pipeline or a terminal outside Claude Code for production.'].join('\n');
  writeSync(2, msg + '\n');
  process.exit(2);
}

export async function main() {
  // Hard deadline for the whole check. It fires even while a query runs,
  // and it ends the hook with exit 2 before Claude Code's 60 s hook timeout.
  setTimeout(() => deny(['The guard ran out of time, so it cannot confirm that the command is safe.']), TOTAL_BUDGET_MS + 5000);
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    deny(['The hook input is not valid JSON.']);
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') deny(['The hook input has no tool_input.command string.']);

  const table = loadCommandTable();
  const results = analyze(command, table);
  const blocks = results.filter((r) => r.kind === 'block');
  if (blocks.length) deny(blocks.map((b) => b.reason));

  const checks = results.filter((r) => r.kind === 'check');
  if (!checks.length) process.exit(0);

  const sfBin = findSfBin();
  if (!sfBin) deny(['The guard cannot find the sf CLI, so it cannot check the target org.']);
  const cwd = typeof input.cwd === 'string' && existsSync(input.cwd) ? input.cwd : os.homedir();
  const allowlist = loadAllowlist();
  const byTarget = new Map();
  for (const c of checks) for (const t of c.targets) byTarget.set(t, [...(byTarget.get(t) ?? []), c.id]);

  const problems = [];
  const answers = await Promise.all([...byTarget.keys()].map((t) => queryOrg(sfBin, t, cwd)));
  let n = 0;
  for (const [target, ids] of byTarget) {
    const cmds = [...new Set(ids)].map(pretty).join(', ');
    const q = answers[n++];
    if (q.error) {
      problems.push(`Cannot confirm that org "${target}" is not production (${q.error}). Command: ${cmds}. Make sure the alias exists ("sf org list") and the login is current.`);
      continue;
    }
    const verdict = classify(q.rec, allowlist);
    if (!verdict.ok) {
      const r = q.rec;
      problems.push(`Org "${target}" is a PRODUCTION org: Name="${r.Name ?? ''}", Id=${r.Id}, OrganizationType="${r.OrganizationType ?? ''}", IsSandbox=${r.IsSandbox}, TrialExpirationDate=${r.TrialExpirationDate ?? 'none'}. Command: ${cmds}.`);
      if (allowlist.problems.length) problems.push(...allowlist.problems);
    }
  }
  if (problems.length) deny(problems);
  process.exit(0);
}
