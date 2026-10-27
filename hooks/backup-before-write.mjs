// PreToolUse: Write (before an overwrite) and Bash (before an rm)
//
// Copies each file that is about to be destroyed into deletions/, named
// <timestamp>_<basename>. The Stop hook prunes that directory after 14 days.
// This implements the "no hard deletes" iron rule for the cases a tool call can
// cause on its own.
//
// Replaces two PowerShell hooks that differed only in where the target came
// from, so both paths are handled here.

import { existsSync, statSync, mkdirSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readPayload, timestamp } from './_lib.mjs';

const input = readPayload().tool_input ?? {};
const targets = [];

if (input.file_path) {
  // Write: a single file, about to be overwritten.
  targets.push(input.file_path);
} else if (input.command && /\brm\b|\bRemove-Item\b/i.test(input.command)) {
  // Bash: pull the operands out of the command line, dropping the verb and
  // any flags. Anything that is not an existing file is skipped below.
  for (const part of input.command.split(/\s+/)) {
    if (!part || part.startsWith('-')) continue;
    if (/^(rm|Remove-Item)$/i.test(part)) continue;
    targets.push(part.replace(/^['"]|['"]$/g, ''));
  }
}

for (const target of targets) {
  try {
    if (!existsSync(target) || !statSync(target).isFile()) continue;
    const dir = join(process.cwd(), 'deletions');
    mkdirSync(dir, { recursive: true });
    copyFileSync(target, join(dir, `${timestamp()}_${basename(target)}`));
  } catch {
    // A backup that fails must never block the session — that is the whole
    // point of the exit 0 convention these hooks inherited.
  }
}

process.exit(0);
