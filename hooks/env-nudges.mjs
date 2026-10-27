// SessionStart
//
// Two cheap checks for the states that waste the first few minutes of a
// session: dependencies never installed, and a missing local env file.
//
// The PowerShell version emitted a separate JSON object per condition, so when
// both fired it wrote two objects back to back. This collects them into one
// message instead.

import { existsSync } from 'node:fs';
import { notify } from './_lib.mjs';

const notes = [];

if (existsSync('package.json') && !existsSync('node_modules')) {
  notes.push('⚠️ קובץ package.json קיים אך תיקיית node_modules חסרה. מומלץ להריץ npm install');
}

if (existsSync('.env.example') && !existsSync('.env')) {
  notes.push('🔑 קובץ .env חסר אך קיים .env.example. כדאי להעתיק וליצור קובץ הגדרות מקומי.');
}

if (notes.length) notify(notes.join(' | '));
process.exit(0);
