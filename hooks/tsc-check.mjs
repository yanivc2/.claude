#!/usr/bin/env node
// PostToolUse hook (Write|Edit): after a .ts/.tsx file changes in a project
// that has a tsconfig.json, run `npx tsc --noEmit` and report the first five
// lines of trouble. It only reports — it never edits or reverts anything.
//
// Node, not PowerShell, so the same command works on Windows and macOS.
// `shell: true` is what makes npx resolvable on both (npx.cmd on Windows).
// Any internal error exits 0 silently — a broken hook must never block a session.
//
// Registered in settings.json under hooks.PostToolUse.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const out = (msg) => process.stdout.write(JSON.stringify({ systemMessage: msg }));

try {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const file = String((payload.tool_input && payload.tool_input.file_path) || '');
  if (!/\.(ts|tsx)$/i.test(file) || !existsSync('tsconfig.json')) process.exit(0);

  const r = spawnSync('npx tsc --noEmit', { shell: true, encoding: 'utf8' });
  if (r.status !== 0) {
    const lines = `${r.stdout || ''}${r.stderr || ''}`
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .slice(0, 5);
    if (lines.length) out(`⚠️ TypeScript: ${lines.join(' | ')}`);
  }
} catch {
  // stay silent
}
process.exit(0);
