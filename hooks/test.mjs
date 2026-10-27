// Tests for the hook scripts in this directory.  Run:  node hooks/test.mjs
//
// These exist because the PowerShell one-liners they replaced could not be
// tested at all — JSON escaped inside JSON inside a shell string is unreadable
// and unrunnable outside a live session. A guard that has never been exercised
// is a guard you are hoping works. Every refusal below is asserted.

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const failures = [];

function run(script, payload, cwd = HERE) {
  const result = spawnSync(process.execPath, [join(HERE, script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
  });
  return { code: result.status, out: result.stdout ?? '' };
}

function check(label, condition, detail = '') {
  if (condition) passed++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

function expectBlock(script, label, payload) {
  const { code, out } = run(script, payload);
  check(label, code === 1 && out.includes('"continue":false'), `exit ${code}, out ${out || '(empty)'}`);
}

function expectAllow(script, label, payload) {
  const { code, out } = run(script, payload);
  check(label, code === 0 && !out.includes('"continue":false'), `exit ${code}, out ${out || '(empty)'}`);
}

// ---------------------------------------------------------------- OneDrive

const ONEDRIVE_WIN = 'C:\\Users\\yaniv\\OneDrive\\Documents\\ledger.xlsx';
const ONEDRIVE_MAC = '/Users/yaniv/Library/CloudStorage/OneDrive-Company/ledger.xlsx';

expectBlock('guard-onedrive.mjs', 'blocks a Windows OneDrive write', {
  tool_input: { file_path: ONEDRIVE_WIN },
});
expectBlock('guard-onedrive.mjs', 'blocks a macOS CloudStorage OneDrive write', {
  tool_input: { file_path: ONEDRIVE_MAC },
});
expectAllow('guard-onedrive.mjs', 'allows an ordinary write', {
  tool_input: { file_path: '/Users/yaniv/Projects/app/src/index.ts' },
});
expectAllow('guard-onedrive.mjs', 'allows a payload with no file_path', { tool_input: {} });
expectAllow('guard-onedrive.mjs', 'allows an empty payload', {});

// -------------------------------------------------------------------- Bash

expectBlock('guard-bash.mjs', 'blocks rm -rf', { tool_input: { command: 'rm -rf build' } });
expectBlock('guard-bash.mjs', 'blocks git reset --hard', {
  tool_input: { command: 'git reset --hard origin/main' },
});
expectBlock('guard-bash.mjs', 'blocks DROP TABLE regardless of case', {
  tool_input: { command: 'psql -c "DROP TABLE users"' },
});
expectBlock('guard-bash.mjs', 'blocks a move into macOS OneDrive', {
  tool_input: { command: `mv report.xlsx "${ONEDRIVE_MAC}"` },
});
expectBlock('guard-bash.mjs', 'blocks a Remove-Item inside Windows OneDrive', {
  tool_input: { command: `Remove-Item "${ONEDRIVE_WIN}"` },
});
expectBlock('guard-bash.mjs', 'blocks reading .env', { tool_input: { command: 'cat .env' } });
expectBlock('guard-bash.mjs', 'blocks reading session.json', {
  tool_input: { command: 'Get-Content session.json' },
});
expectBlock('guard-bash.mjs', 'blocks reading a client_secret', {
  tool_input: { command: 'head client_secret_1234.json' },
});

expectAllow('guard-bash.mjs', 'allows reading .env.example', {
  tool_input: { command: 'cat .env.example' },
});
expectAllow('guard-bash.mjs', 'allows a plain listing', { tool_input: { command: 'ls -la' } });
expectAllow('guard-bash.mjs', 'allows git status', { tool_input: { command: 'git status' } });
expectAllow('guard-bash.mjs', 'allows reading from OneDrive (read is permitted)', {
  tool_input: { command: `cat "${ONEDRIVE_MAC}"` },
});
expectAllow('guard-bash.mjs', 'allows an empty payload', {});

// ------------------------------------------------------------------ backups

const sandbox = mkdtempSync(join(tmpdir(), 'hook-test-'));
try {
  const victim = join(sandbox, 'notes.md');
  writeFileSync(victim, 'original content');

  run('backup-before-write.mjs', { tool_input: { file_path: victim } }, sandbox);
  const afterWrite = existsSync(join(sandbox, 'deletions'))
    ? readdirSync(join(sandbox, 'deletions'))
    : [];
  check(
    'backs up an existing file before a Write overwrites it',
    afterWrite.some((f) => f.endsWith('_notes.md')),
    `deletions/ held [${afterWrite.join(', ')}]`,
  );

  const doomed = join(sandbox, 'stale.txt');
  writeFileSync(doomed, 'bye');
  run('backup-before-write.mjs', { tool_input: { command: `rm -f ${doomed}` } }, sandbox);
  const afterRm = readdirSync(join(sandbox, 'deletions'));
  check(
    'backs up a file named on an rm command line',
    afterRm.some((f) => f.endsWith('_stale.txt')),
    `deletions/ held [${afterRm.join(', ')}]`,
  );

  const clean = mkdtempSync(join(tmpdir(), 'hook-test-'));
  try {
    const { code } = run(
      'backup-before-write.mjs',
      { tool_input: { file_path: join(clean, 'does-not-exist.txt') } },
      clean,
    );
    check('exits 0 when there is nothing to back up', code === 0, `exit ${code}`);
    check(
      'creates no deletions/ when there is nothing to back up',
      !existsSync(join(clean, 'deletions')),
    );
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

// ------------------------------------------------------- project template
//
// The template ships its own standalone hooks, invoked from a seeded project.
// They must behave like the ones here: exit 0, valid JSON or nothing.

const TEMPLATE = join(HERE, '..', 'templates', 'project', '.claude', 'hooks');
for (const script of ['banner.mjs', 'precompact-notice.mjs', 'lint-check.mjs']) {
  const path = join(TEMPLATE, script);
  check(`template ships ${script}`, existsSync(path));
  if (!existsSync(path)) continue;
  const result = spawnSync(process.execPath, [path], {
    input: JSON.stringify({ tool_input: { file_path: 'README.md' } }),
    encoding: 'utf8',
    cwd: TEMPLATE,
  });
  check(`template ${script} exits 0`, result.status === 0, `exit ${result.status}`);
  const out = (result.stdout ?? '').trim();
  if (out) {
    let parses = true;
    try {
      JSON.parse(out);
    } catch {
      parses = false;
    }
    check(`template ${script} writes valid JSON`, parses, out.slice(0, 120));
  }
}

// Every hook command in every settings file must name a script that exists.
for (const [settings, root] of [
  [join(HERE, '..', 'settings.json'), join(HERE, '..')],
  [join(HERE, '..', '.claude', 'settings.json'), join(HERE, '..')],
  [join(HERE, '..', 'templates', 'project', '.claude', 'settings.json'), join(TEMPLATE, '..', '..')],
]) {
  if (!existsSync(settings)) continue;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settings, 'utf8'));
  } catch {
    check(`${settings} parses as JSON`, false);
    continue;
  }
  for (const groups of Object.values(parsed.hooks ?? {})) {
    for (const group of groups) {
      for (const hook of group.hooks) {
        if (hook.type !== 'command') continue;
        check(`${settings}: hook is not pinned to a shell`, !hook.shell, hook.shell ?? '');
        const name = hook.command.match(/hooks[\\/]([a-z-]+\.mjs)/)?.[1];
        check(`${settings}: names a script`, Boolean(name), hook.command.slice(0, 70));
        if (!name) continue;
        const candidates = [join(root, 'hooks', name), join(root, '.claude', 'hooks', name)];
        check(`${settings}: ${name} exists`, candidates.some(existsSync));
      }
    }
  }
}

// -------------------------------------------------------------------- smoke
//
// The remaining hooks have no refusal to assert, but they must never end a
// session in an error and must never emit malformed JSON. They run in an empty
// directory with HOME redirected, so exercising them cannot touch the real
// config — and the redirect also puts each one through its own failure path.

const quiet = mkdtempSync(join(tmpdir(), 'hook-smoke-'));
try {
  for (const script of [
    'seed-project.mjs',
    'env-nudges.mjs',
    'session-summary.mjs',
    'precompact-notice.mjs',
    'repo-banner.mjs',
    'session-log.mjs',
    'typecheck.mjs',
  ]) {
    const result = spawnSync(process.execPath, [join(HERE, script)], {
      input: '{}',
      encoding: 'utf8',
      cwd: quiet,
      env: { ...process.env, HOME: quiet, USERPROFILE: quiet },
    });
    check(
      `${script} exits 0 in an empty directory`,
      result.status === 0,
      `exit ${result.status} ${(result.stderr ?? '').trim()}`,
    );
    const out = (result.stdout ?? '').trim();
    if (out) {
      let parses = true;
      try {
        JSON.parse(out);
      } catch {
        parses = false;
      }
      check(`${script} writes valid JSON`, parses, out.slice(0, 120));
    }
  }
} finally {
  rmSync(quiet, { recursive: true, force: true });
}

// ------------------------------------------------------------------- report

if (failures.length === 0) {
  console.log(`✅ ${passed} assertions passed`);
  process.exit(0);
}
console.error(`❌ ${failures.length} failed, ${passed} passed:`);
for (const f of failures) console.error(`   • ${f}`);
process.exit(1);
