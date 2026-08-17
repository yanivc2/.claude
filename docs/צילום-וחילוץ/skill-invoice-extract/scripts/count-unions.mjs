#!/usr/bin/env node
// count-unions.mjs — the schema-union gate.
// The structured-output API rejects a schema with more than 16 union-typed parameters
// ("type arrays or anyOf"). Adding one nullable field can silently 400 EVERY extraction.
// This counts them and fails above the ceiling. Dependency-free (Node 18+).
//
//   node count-unions.mjs <schema.json> [--max 16]
//
// A node counts as a union if it has anyOf/oneOf OR its `type` is an array (e.g. ["number","null"]).

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const max = Number((args.find((a) => a.startsWith('--max='))?.split('=')[1]) ?? 16);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node count-unions.mjs <schema.json> [--max=16]');
  process.exit(2);
}

let schema;
try {
  schema = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`cannot read/parse ${file}: ${e.message}`);
  process.exit(2);
}

const unions = [];
function isUnion(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) return true;
  if (Array.isArray(node.type)) return true; // e.g. ["number","null"]
  return false;
}
// Walk every schema node; record the path of each union-typed one.
function walk(node, path) {
  if (!node || typeof node !== 'object') return;
  if (path && isUnion(node)) unions.push(path);
  if (node.properties) for (const [k, v] of Object.entries(node.properties)) walk(v, `${path}.${k}`);
  if (node.items) walk(node.items, `${path}[]`);
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(node[key])) node[key].forEach((s, i) => walk(s, `${path}(${key}:${i})`));
  }
  if (node.$defs) for (const [k, v] of Object.entries(node.$defs)) walk(v, `${path}$defs.${k}`);
}
walk(schema, 'root');

const n = unions.length;
console.log(`union-typed parameters: ${n} (ceiling ${max})`);
for (const p of unions) console.log(`  • ${p}`);
if (n > max) {
  console.error(`\nFAIL: ${n} > ${max}. Make text fields plain "string" ("" = absent); keep only numeric fields nullable.`);
  process.exit(1);
}
console.log('\nOK: within the union ceiling.');
