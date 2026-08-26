#!/usr/bin/env node
// Stop hook for the doc-sync skill. Runs when Claude finishes a turn and nudges the session to keep
// INDEX.md + CLAUDE.md in sync with code changes — automatically, without being asked.
//
// It does two things, both fail-safe (any internal error -> exit 0 = allow the stop):
//   1) Runs `scripts/doc-check.mjs`. If the docs guard fails, block the stop with the failure text so
//      the session fixes the docs before finishing.
//   2) If the working tree has uncommitted changes under src/ but INDEX.md/CLAUDE.md were NOT touched,
//      block ONCE to ask the session to run the doc-sync skill. `stop_hook_active` guards against loops:
//      when it's already true (we blocked on the previous stop) we do not block again on drift.
//
// A hook that locks the user out is worse than one that misses a case, so every failure path allows.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('..', import.meta.url).pathname;
const allow = () => process.exit(0);

function main() {
  // Read the Stop hook payload from stdin (fd 0). Empty/malformed -> treat as first stop.
  let stopHookActive = false;
  try {
    const raw = readFileSync(0, 'utf8');
    if (raw && raw.trim()) stopHookActive = !!JSON.parse(raw).stop_hook_active;
  } catch {
    /* no payload — first stop */
  }

  // 1) Docs guard. If it fails, block with its output so the docs get fixed before finishing.
  if (existsSync(root + 'scripts/doc-check.mjs')) {
    try {
      execFileSync('node', ['scripts/doc-check.mjs'], { cwd: root, stdio: 'pipe' });
    } catch (e) {
      if (stopHookActive) allow(); // already blocked once — don't loop on a persistent guard failure.
      const out = ((e.stdout || '') + '\n' + (e.stderr || '')).toString().trim();
      console.log(JSON.stringify({
        decision: 'block',
        reason: 'doc-check.mjs failed — the docs are out of sync with the code. Run the doc-sync skill, ' +
          'fix INDEX.md/CLAUDE.md until `node scripts/doc-check.mjs` passes, then finish.\n\n' + out,
      }));
      process.exit(0);
    }
  }

  if (stopHookActive) allow(); // second pass: guard is clean, don't re-nag about drift.

  // 2) Drift check: source changed but the docs didn't. Nudge once to run doc-sync.
  try {
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, stdio: 'pipe' })
      .toString();
    const files = status.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
    const srcTouched = files.some((f) => f.startsWith('src/'));
    const docsTouched = files.some((f) => f === 'INDEX.md' || f === 'CLAUDE.md');
    if (srcTouched && !docsTouched) {
      console.log(JSON.stringify({
        decision: 'block',
        reason: 'You changed files under src/ but did not touch INDEX.md or CLAUDE.md. Invoke the ' +
          'doc-sync skill: update the affected INDEX.md row(s) (and CLAUDE.md only if a standing rule ' +
          'changed), verify each claim against the code, then run `node scripts/doc-check.mjs`. If the ' +
          'change genuinely needs no doc update, say so briefly and stop again.',
      }));
      process.exit(0);
    }
  } catch {
    /* not a git repo / git unavailable — nothing to check */
  }

  allow();
}

try { main(); } catch { allow(); }
