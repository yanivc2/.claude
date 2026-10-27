// PostToolUse: Write | Edit
//
// Runs the project's TypeScript check after a .ts/.tsx file changes, so a type
// error surfaces immediately instead of at the next build. Replaces two
// identical PowerShell hooks that differed only in their matcher.
//
// shell: true is required because npx is npx.cmd on Windows and Node cannot
// spawn a .cmd directly. The arguments are fixed literals, not interpolated.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readPayload, notify } from './_lib.mjs';

const ERROR_LINES = 5;

const file = readPayload().tool_input?.file_path ?? '';
if (!/\.(ts|tsx)$/.test(file) || !existsSync('tsconfig.json')) process.exit(0);

const result = spawnSync('npx', ['tsc', '--noEmit'], {
  encoding: 'utf8',
  shell: true,
});

if (result.status !== 0) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, ERROR_LINES)
    .join(' | ');
  if (output) notify('⚠️ TypeScript: ' + output);
}

process.exit(0);
