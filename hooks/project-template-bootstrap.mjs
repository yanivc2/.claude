#!/usr/bin/env node
// SessionStart hook: seed a repo of mine from ~/.claude/templates/project.
//
// It fires only in a git repo that has no .claude/settings.json yet, and only
// when the origin remote is mine (an empty/absent origin counts as mine — a
// brand-new local repo). Nothing already present is overwritten except the
// project settings.json, which is the file whose absence triggered the run.
//
// Node, not PowerShell, so the same command works on Windows and macOS.
// Any internal error exits 0 silently — a broken hook must never block a session.
//
// Registered in settings.json under hooks.SessionStart.

import { existsSync, mkdirSync, copyFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const out = (msg) => process.stdout.write(JSON.stringify({ systemMessage: msg }));

try {
  if (existsSync('.git') && !existsSync(join('.claude', 'settings.json'))) {
    let origin = '';
    try {
      origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      origin = ''; // no remote, or no git — treated as mine, like the shell version
    }

    if (!origin || origin.toLowerCase().includes('yanivc2')) {
      const base = join(homedir(), '.claude', 'templates', 'project');
      const copyIfMissing = (src, dest) => {
        if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
      };

      mkdirSync('.claude', { recursive: true });
      copyFileSync(join(base, '.claude', 'settings.json'), join('.claude', 'settings.json'));
      copyIfMissing(join(base, '.mcp.json'), '.mcp.json');
      copyIfMissing(join(base, 'CLAUDE.md'), 'CLAUDE.md');
      copyIfMissing(join(base, 'SETUP.md'), 'SETUP.md');
      copyIfMissing(join(base, '.gitignore'), '.gitignore');
      if (!existsSync(join('.claude', 'rules')) && existsSync(join(base, '.claude', 'rules'))) {
        cpSync(join(base, '.claude', 'rules'), join('.claude', 'rules'), { recursive: true });
      }

      let msg = '📋 הוגדר מה-template: CLAUDE.md + SETUP.md + .claude/rules/ + settings.json';
      if (existsSync('rules')) {
        msg += ' | ⚠️ קיימת תיקיית rules/ ישנה — הכללים עברו ל-.claude/rules/ ונטענים לפי הצורך.'
          + ' אפשר להסיר ידנית אחרי בדיקה.';
      }
      out(msg);
    }
  }
} catch {
  // stay silent
}
process.exit(0);
