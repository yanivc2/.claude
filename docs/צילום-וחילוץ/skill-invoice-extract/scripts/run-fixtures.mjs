#!/usr/bin/env node
// run-fixtures.mjs — the validator suite. Runs the known-answer regression over every fixture pair
// in fixtures/by-supplier/ (<name>.expected.json vs <name>.actual.json) plus the top-level demo
// pair, and runs check-invariants on each actual. Reports overall pass. Dependency-free (Node 18+).
//
//   node run-fixtures.mjs
//
// Add a real invoice per supplier as <supplier>.expected.json (+ .actual.json) to watch for drift.

import { readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const reg = join(here, 'regression.mjs');
const inv = join(here, 'check-invariants.mjs');

const pairs = [];
const bySup = join(root, 'fixtures', 'by-supplier');
if (existsSync(bySup)) {
  for (const f of readdirSync(bySup).sort()) {
    if (!f.endsWith('.expected.json')) continue;
    const base = f.replace('.expected.json', '');
    pairs.push([join(bySup, f), join(bySup, `${base}.actual.json`), base]);
  }
}
if (existsSync(join(root, 'fixtures', 'expected.json'))) {
  pairs.push([join(root, 'fixtures', 'expected.json'), join(root, 'fixtures', 'actual.json'), 'demo']);
}

let fail = 0;
for (const [e, a, name] of pairs) {
  let ok = true;
  try { execFileSync('node', [inv, a], { stdio: 'pipe' }); } catch { ok = false; }
  try { execFileSync('node', [reg, e, a], { stdio: 'pipe' }); } catch { ok = false; }
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
}
console.log(fail ? `\n${fail} fixture(s) failed` : `\n✅ all ${pairs.length} fixture(s) passed`);
process.exit(fail ? 1 : 0);
