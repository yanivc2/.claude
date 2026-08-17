#!/usr/bin/env node
// regression.mjs — known-answer diff for an extraction. Compares an ACTUAL extraction against an
// EXPECTED one (a real invoice hand-verified once), field by field, and reports a pass ratio.
// Keep one fixture per supplier + an overall set; watch the ratio for DRIFT over time.
// Dependency-free (Node 18+).
//
//   node regression.mjs <expected.json> <actual.json> [--min=1.0]
//
// Normalizes "" ↔ null, trims strings, compares numbers with a small tolerance. Lines match by index.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const min = Number((args.find((a) => a.startsWith('--min='))?.split('=')[1]) ?? 1);
const [expFile, actFile] = args.filter((a) => !a.startsWith('--'));
if (!expFile || !actFile) {
  console.error('usage: node regression.mjs <expected.json> <actual.json> [--min=1.0]');
  process.exit(2);
}
const load = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch (e) { console.error(`cannot read ${f}: ${e.message}`); process.exit(2); } };
const expected = load(expFile);
const actual = load(actFile);

const norm = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v.trim() : v);
function eq(a, b) {
  a = norm(a); b = norm(b);
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a), nb = Number(b);
    if (Number.isNaN(na) || Number.isNaN(nb)) return String(a) === String(b);
    return Math.abs(na - nb) < 1e-6;
  }
  return String(a) === String(b);
}

let pass = 0, total = 0;
const fails = [];
function cmp(path, a, b) { total++; if (eq(a, b)) pass++; else fails.push(`${path}: expected ${JSON.stringify(norm(a))}, got ${JSON.stringify(norm(b))}`); }

// Header: compare every key present in expected.
for (const k of Object.keys(expected)) {
  if (k === 'lines') continue;
  cmp(`header.${k}`, expected[k], actual[k]);
}
// Lines by index.
const eLines = Array.isArray(expected.lines) ? expected.lines : [];
const aLines = Array.isArray(actual.lines) ? actual.lines : [];
if (eLines.length !== aLines.length) fails.push(`lines: expected ${eLines.length} rows, got ${aLines.length}`);
eLines.forEach((el, i) => {
  const al = aLines[i] || {};
  for (const k of Object.keys(el)) cmp(`lines[${i}].${k}`, el[k], al[k]);
});

const ratio = total ? pass / total : 1;
console.log(`fields matched: ${pass}/${total} = ${(ratio * 100).toFixed(1)}%  (min ${(min * 100).toFixed(0)}%)`);
if (fails.length) { console.log('mismatches:'); for (const f of fails) console.log(`  ✗ ${f}`); }
if (ratio < min || eLines.length !== aLines.length) { console.error('\nFAIL: below threshold / row-count mismatch.'); process.exit(1); }
console.log('\nOK: known-answer regression passed.');
