#!/usr/bin/env node
// PreToolUse hook: keep .env out of the context. Shell-ish tools are judged by
// their command line, file tools by the path they are about to touch.
//
// Node replacement for block-secrets.ps1 — same regex, same message, same
// exit 2 (a blocking error, with the reason going to the model on stderr).
// Node also reads UTF-8, so the Hebrew message no longer depends on a BOM the
// way an ANSI-parsed .ps1 did.
//
// A payload that cannot be read exits 0: this guard fails open, like the
// original, and the deny list in settings.json is the real backstop.
//
// Registered in settings.json under hooks.PreToolUse.

import { readFileSync } from 'node:fs';

const CMD_TOOLS = new Set(['Bash', 'PowerShell', 'Shell']);
const DOTENV = /(^|[^A-Za-z0-9_])\.env($|[^A-Za-z0-9_])/i;

try {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }

  const input = payload.tool_input || {};
  const str = (v) => (v === undefined || v === null ? '' : String(v));
  const target = CMD_TOOLS.has(payload.tool_name)
    ? str(input.command)
    : `${str(input.file_path)} ${str(input.path)} ${str(input.notebook_path)}`;

  if (DOTENV.test(target)) {
    process.stderr.write('חסום: קובץ הסודות אינו נכנס להקשר.\n');
    process.exit(2);
  }
} catch {
  // fail open
}
process.exit(0);
