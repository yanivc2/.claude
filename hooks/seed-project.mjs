// SessionStart
//
// Seeds a new repository from templates/project/ so a fresh project starts with
// path-scoped rules, a project CLAUDE.md and the per-project hooks.
//
// Two guards keep this from touching anything it shouldn't:
//   • it runs only in a git repo that has no .claude/settings.json yet
//   • it runs only when origin is this user's own, so cloning someone else's
//     repository never rewrites it (a repo with no remote at all is still
//     seeded — that is a new local project)
//
// Every file is copied ONLY IF ABSENT. Nothing here overwrites existing work.

import { existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { notify } from './_lib.mjs';

if (!existsSync('.git')) process.exit(0);
if (existsSync(join('.claude', 'settings.json'))) process.exit(0);

let origin = '';
try {
  origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
} catch {
  origin = ''; // no remote configured — a new local project
}
if (origin && !origin.includes('yanivc2')) process.exit(0);

const base = join(homedir(), '.claude', 'templates', 'project');
if (!existsSync(base)) process.exit(0);

function copyIfAbsent(from, to, { recursive = false } = {}) {
  if (!existsSync(from) || existsSync(to)) return;
  if (recursive) cpSync(from, to, { recursive: true });
  else copyFileSync(from, to);
}

try {
  mkdirSync('.claude', { recursive: true });
  copyIfAbsent(join(base, '.claude', 'settings.json'), join('.claude', 'settings.json'));
  copyIfAbsent(join(base, '.claude', 'rules'), join('.claude', 'rules'), { recursive: true });
  // The seeded settings.json invokes these by path, so they must travel with it.
  copyIfAbsent(join(base, '.claude', 'hooks'), join('.claude', 'hooks'), { recursive: true });
  copyIfAbsent(join(base, '.mcp.json'), '.mcp.json');
  copyIfAbsent(join(base, 'CLAUDE.md'), 'CLAUDE.md');
  copyIfAbsent(join(base, 'SETUP.md'), 'SETUP.md');
  copyIfAbsent(join(base, '.gitignore'), '.gitignore');
} catch {
  process.exit(0); // never block a session over scaffolding
}

let message = '📋 הוגדר מה-template: CLAUDE.md + SETUP.md + .claude/rules/ + settings.json';
if (existsSync('rules')) {
  message +=
    ' | ⚠️ קיימת תיקיית rules/ ישנה — הכללים עברו ל-.claude/rules/ ונטענים לפי הצורך.' +
    ' אפשר להסיר ידנית אחרי בדיקה.';
}
notify(message);
process.exit(0);
