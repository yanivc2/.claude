#!/usr/bin/env node
// Stop hook: at the end of a turn, show what the working tree now differs by —
// `git diff HEAD --stat`, first 12 lines. Read-only; it never stages, commits
// or resets anything.
//
// Node, not PowerShell, so the same command works on Windows and macOS.
// Any internal error exits 0 silently — a broken hook must never block a session.
//
// Registered in settings.json under hooks.Stop.

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const out = (msg) => process.stdout.write(JSON.stringify({ systemMessage: msg }));

try {
  if (existsSync('.git')) {
    let stat = '';
    try {
      // 2>&1 in the original: a git error was reported too, not swallowed.
      stat = execFileSync('git', ['diff', 'HEAD', '--stat'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      stat = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`;
    }

    const lines = String(stat)
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(0, 12);
    // Real newlines, not the literal \n the single-quoted PowerShell join produced.
    if (lines.length) out(`📝 ${lines.join('\n')}`);
  }
} catch {
  // stay silent
}
process.exit(0);
