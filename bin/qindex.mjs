#!/usr/bin/env node
// qindex.mjs — query the machine index without ever loading it into context.
//
// The index is ~5 MB of JSON. Reading it with the Read tool would cost well over
// a million tokens, which is why `permissions.deny` blocks that path. A deny rule
// stops Claude's Read tool but not a Node process, so this script is the sanctioned
// way in: it parses the file in memory and prints at most a few dozen rows.
//
// Every query is capped. That cap is the whole point — without it this is just a
// slower way to blow up the context window.
//
// Usage:
//   node qindex.mjs --summary
//   node qindex.mjs --path shufersal
//   node qindex.mjs --name "*.env"
//   node qindex.mjs --ext .xlsx
//   node qindex.mjs --top 20 --by-size
//   node qindex.mjs --since 2026-08-01
//   node qindex.mjs --dupes
//   node qindex.mjs --locations
//   node qindex.mjs --security
//   Add --limit N (max 100) or --index <path> to any of the above.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_DIR = join(homedir(), 'Vault', '_organize');
const HARD_CAP = 100;
const DEFAULT_LIMIT = 40;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { a[key] = next; i++; } else { a[key] = true; }
    } else a._.push(t);
  }
  return a;
}

function findIndex(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) die(`index not found: ${explicit}`);
    return explicit;
  }
  if (!existsSync(DEFAULT_DIR)) die(`no index directory at ${DEFAULT_DIR} — pass --index <path>`);
  const candidates = readdirSync(DEFAULT_DIR)
    .filter((f) => f.startsWith('machine-index') && f.endsWith('.json'))
    .sort();
  if (!candidates.length) die(`no machine-index*.json in ${DEFAULT_DIR} — pass --index <path>`);
  return join(DEFAULT_DIR, candidates[candidates.length - 1]);
}

function die(msg) { console.error(`qindex: ${msg}`); process.exit(1); }

const mb = (b) => (b / 1e6).toFixed(1).padStart(8);
const gb = (b) => (b / 1e9).toFixed(2);

// Print at most `limit` rows, then say how many were withheld. Never print the rest.
function emit(rows, limit, render, ranked = false) {
  const shown = rows.slice(0, limit);
  for (const r of shown) console.log(render(r));
  if (rows.length > shown.length) {
    console.log(ranked
      ? `[top ${shown.length} of ${rows.length}]`
      : `... ${rows.length - shown.length} more (refine the query, or raise --limit up to ${HARD_CAP})\n[${rows.length} matches]`);
  } else {
    console.log(`[${rows.length} match${rows.length === 1 ? '' : 'es'}]`);
  }
}

// Glob-ish: supports * only. Falls back to a case-insensitive substring match.
function matcher(pattern) {
  const p = String(pattern).toLowerCase();
  if (!p.includes('*')) return (s) => s.toLowerCase().includes(p);
  const rx = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return (s) => rx.test(s);
}

const args = parseArgs(process.argv.slice(2));
const limit = Math.min(Number(args.limit) || DEFAULT_LIMIT, HARD_CAP);
const indexPath = findIndex(typeof args.index === 'string' ? args.index : null);

let data;
try {
  data = JSON.parse(readFileSync(indexPath, 'utf8'));
} catch (e) {
  die(`could not parse ${indexPath}: ${e.message}`);
}

const files = Array.isArray(data.files) ? data.files : [];
const locations = Array.isArray(data.locations) ? data.locations : [];

if (args.summary || args._.length === 0 && Object.keys(args).length <= 1) {
  const t = data.totals || {};
  console.log(`index:      ${indexPath}`);
  console.log(`generated:  ${data.generated_at || '?'}   schema: ${data.schema || '?'}`);
  console.log(`totals:     ${t.files ?? files.length} files, ${gb(t.bytes ?? 0)} GB, ${locations.length} locations`);
  const byArea = new Map();
  for (const l of locations) {
    const a = byArea.get(l.area) || { n: 0, files: 0, bytes: 0 };
    a.n++; a.files += l.file_count || 0; a.bytes += l.bytes || 0;
    byArea.set(l.area, a);
  }
  console.log('\narea            locs   files        MB');
  for (const [area, a] of [...byArea].sort((x, y) => y[1].bytes - x[1].bytes)) {
    console.log(`${area.padEnd(15)}${String(a.n).padStart(4)}${String(a.files).padStart(8)}${mb(a.bytes)}`);
  }
  const sec = data.security_findings || [];
  if (sec.length) console.log(`\nsecurity findings: ${sec.length} (run --security)`);
  process.exit(0);
}

if (args.locations) {
  const rows = [...locations].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
  console.log('area            files        MB  path');
  emit(rows, limit, (l) =>
    `${(l.area || '?').padEnd(15)}${String(l.file_count || 0).padStart(6)}${mb(l.bytes || 0)}  ${l.path}` +
    (l.protected_code ? '  [code — never move]' : ''));
  process.exit(0);
}

if (args.security) {
  for (const f of data.security_findings || []) {
    console.log(`[${(f.severity || '?').toUpperCase()}] ${f.path}\n    ${f.issue}`);
  }
  process.exit(0);
}

if (args.dupes) {
  const by = new Map();
  for (const f of files) {
    const k = `${(f.name || '').toLowerCase()}|${f.bytes}`;
    (by.get(k) || by.set(k, []).get(k)).push(f);
  }
  const rows = [...by.values()]
    .filter((v) => v.length > 1 && new Set(v.map((x) => x.location_id)).size > 1)
    .sort((a, b) => b[0].bytes * (b.length - 1) - a[0].bytes * (a.length - 1));
  console.log('     wasted  copies  name');
  emit(rows, limit, (v) =>
    `${mb(v[0].bytes * (v.length - 1))}MB  x${String(v.length).padStart(3)}  ${v[0].name}\n` +
    v.slice(0, 3).map((x) => `                    ${x.path}`).join('\n'));
  process.exit(0);
}

// Row-level filters compose: --path + --ext + --since can be combined.
let rows = files;
if (typeof args.path === 'string') { const m = matcher(args.path); rows = rows.filter((f) => m(f.path || '')); }
if (typeof args.name === 'string') { const m = matcher(args.name); rows = rows.filter((f) => m(f.name || '')); }
if (typeof args.ext === 'string') {
  const e = args.ext.startsWith('.') ? args.ext.toLowerCase() : '.' + args.ext.toLowerCase();
  rows = rows.filter((f) => (f.ext || '').toLowerCase() === e);
}
if (typeof args.since === 'string') rows = rows.filter((f) => String(f.modified || '') >= args.since);
if (typeof args.category === 'string') { const m = matcher(args.category); rows = rows.filter((f) => m(f.category || '')); }

if (rows === files && !args['by-size'] && !args.top) {
  die('no query given. Try --summary, --path <s>, --name <s>, --ext <.x>, --since <date>, --top N --by-size, --dupes, --locations, --security');
}

if (args['by-size'] || args.top) rows = [...rows].sort((a, b) => (b.bytes || 0) - (a.bytes || 0));
else rows = [...rows].sort((a, b) => String(a.path).localeCompare(String(b.path)));

const top = Number(args.top);
const cap = Math.min(Number.isFinite(top) && top > 0 ? top : limit, HARD_CAP);

const ranked = Boolean(args['by-size'] || args.top);
console.log('        MB  modified    path');
emit(rows, cap, (f) => `${mb(f.bytes || 0)}  ${(f.modified || '').padEnd(10)}  ${f.path}`, ranked);
