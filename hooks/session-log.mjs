// Stop — repo-scoped (.claude/settings.json)
//
// Appends one dated entry to ~/.claude/session-log.md and caps the file at 80
// lines. Do not hand-edit that file; it is regenerated from the top on every
// stop.
//
// Why this port matters beyond portability: the PowerShell version wrote the
// file with `Set-Content -Encoding utf8`, which on Windows PowerShell 5.1
// emits a UTF-8 BOM. The repo's own iron rule forbids exactly that for Hebrew
// files, so the hook was violating the rule it existed to serve. Node writes
// clean UTF-8 with no BOM.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_LINES = 80;
const logFile = join(homedir(), '.claude', 'session-log.md');

const now = new Date();
const p = (n) => String(n).padStart(2, '0');
const stamp =
  `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
  ` ${p(now.getHours())}:${p(now.getMinutes())}`;

let bullet = 'שיחה ללא שינויי קוד';
try {
  const log = execFileSync('git', ['log', '--oneline', '--since=4 hours ago'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (log) bullet = log.split('\n').slice(0, 3).join(' | ');
} catch {
  // not a repo, or no commits in range — the default bullet stands
}

try {
  const existing = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const combined = `## ${stamp}\n- ${bullet}\n\n${existing}`
    .trimEnd()
    .split('\n')
    .slice(0, MAX_LINES)
    .join('\n');
  writeFileSync(logFile, combined + '\n', 'utf8');
} catch {
  // a journal that cannot be written must not end the session in an error
}

process.exit(0);
