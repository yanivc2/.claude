// PostToolUse: Edit | Write
//
// Type-checks and lints the file that just changed, so a break surfaces now
// instead of at the next build. Replaces two PowerShell hooks.
//
// Two fixes carried over from them:
//   • the typecheck used to run on EVERY edit, including Markdown. It is now
//     gated on the same extensions as the lint pass.
//   • tool detection probed node_modules\.bin\prettier.cmd, a Windows-only
//     filename, so on any other platform the lint pass silently never ran.
//
// Standalone by design: a seeded project must not depend on files outside it.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ERROR_LINES = 6;
const CODE = /\.(ts|tsx|js|jsx)$/;

function payload() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

const file = payload().tool_input?.file_path ?? '';
if (!CODE.test(file)) process.exit(0);

/** A local binary exists under either its POSIX or its Windows name. */
function hasLocal(bin) {
  const base = join('node_modules', '.bin', bin);
  return existsSync(base) || existsSync(`${base}.cmd`);
}

function run(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', shell: true });
}

function firstLines(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, ERROR_LINES)
    .join(' | ');
}

const notes = [];

if (existsSync('tsconfig.json')) {
  const tsc = run('npx', ['tsc', '--noEmit']);
  if (tsc.status !== 0) {
    const detail = firstLines(tsc);
    if (detail) notes.push('TypeScript: ' + detail);
  }
}

if (hasLocal('prettier')) {
  const prettier = run('npx', ['prettier', '--check', JSON.stringify(file)]);
  if (prettier.status !== 0) notes.push('Prettier: formatting drift — run prettier --write');
}

if (hasLocal('eslint')) {
  const eslint = run('npx', ['eslint', JSON.stringify(file)]);
  if (eslint.status !== 0) {
    const detail = firstLines(eslint);
    if (detail) notes.push('ESLint: ' + detail);
  }
}

if (notes.length) {
  process.stdout.write(JSON.stringify({ systemMessage: '⚠️ ' + notes.join(' || ') }));
}

process.exit(0);
