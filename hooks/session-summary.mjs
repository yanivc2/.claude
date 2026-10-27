// Stop
//
// Reports what changed in the working tree, then prunes old backups.
// Replaces two PowerShell hooks: they fired on the same event and neither
// depended on the other.
//
// The predecessor joined the diff lines with the two-character string \n
// because PowerShell does not expand escapes inside single quotes, so the
// summary arrived as one line with literal \n in it. This uses a real newline.

import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { notify } from './_lib.mjs';

const DIFF_LINES = 12;
const KEEP_DAYS = 14;

if (existsSync('.git')) {
  try {
    const stat = execFileSync('git', ['diff', 'HEAD', '--stat'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (stat) {
      notify('📝 ' + stat.split('\n').slice(0, DIFF_LINES).join('\n'));
    }
  } catch {
    // no commits yet, or not a working tree — nothing worth reporting
  }
}

const deletions = 'deletions';
if (existsSync(deletions)) {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const name of readdirSync(deletions)) {
    const entry = join(deletions, name);
    try {
      if (statSync(entry).mtimeMs < cutoff) rmSync(entry, { force: true });
    } catch {
      // a file that cannot be stat'd or removed is left alone
    }
  }
}

process.exit(0);
