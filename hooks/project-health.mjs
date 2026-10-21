#!/usr/bin/env node
// SessionStart hook: two cheap sanity checks on the project I just opened —
// dependencies that were never installed, and a missing local .env next to a
// committed .env.example. It only reports; it never installs or creates anything.
//
// Node, not PowerShell, so the same command works on Windows and macOS.
// Any internal error exits 0 silently — a broken hook must never block a session.
//
// Registered in settings.json under hooks.SessionStart.

import { existsSync } from 'node:fs';

const out = (msg) => process.stdout.write(JSON.stringify({ systemMessage: msg }));

try {
  const lines = [];
  if (existsSync('package.json') && !existsSync('node_modules')) {
    lines.push('⚠️ שים לב: קובץ package.json קיים אך תיקיית node_modules חסרה. מומלץ להריץ npm install');
  }
  if (existsSync('.env.example') && !existsSync('.env')) {
    lines.push('🔑 שים לב: קובץ .env חסר אך קיים .env.example. כדאי להעתיק וליצור קובץ הגדרות מקומי.');
  }
  // One JSON object even when both fire — the PowerShell version wrote two,
  // which is not parseable as a single payload.
  if (lines.length) out(lines.join(' | '));
} catch {
  // stay silent
}
process.exit(0);
