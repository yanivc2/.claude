#!/usr/bin/env node
// check-invariants.mjs — assert an extraction OUTPUT obeys the hard invariants.
// Catches the classes of bug the contract exists to prevent, offline, before anything is saved.
// Dependency-free (Node 18+).
//
//   node check-invariants.mjs <extraction.json>
//
// Default field manifest matches the standard invoice shape; edit TEXT/NUMERIC/ENUM for your schema.

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node check-invariants.mjs <extraction.json>');
  process.exit(2);
}
let doc;
try {
  doc = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`cannot read/parse ${file}: ${e.message}`);
  process.exit(2);
}

// Text fields must be plain strings ("" = absent). Numeric fields must be number|null and,
// where they are money/counts on the invoice, non-negative (the sign comes from doc_type later).
const HEADER_TEXT = ['supplier_name', 'supplier_tax_id', 'supplier_phone', 'invoice_number', 'allocation_number', 'invoice_date'];
const HEADER_NUM_NONNEG = ['amount_before_vat', 'vat_amount', 'total_amount'];
const LINE_TEXT = ['name', 'barcode', 'sku'];
const LINE_NUM_NONNEG = ['quantity', 'unit_quantity', 'unit_cost', 'pack_cost', 'line_total'];
const DOC_TYPES = ['tax_invoice', 'tax_invoice_receipt', 'credit_note', 'unknown'];

const problems = [];
const P = (m) => problems.push(m);

function checkText(obj, keys, where) {
  for (const k of keys) {
    if (!(k in obj)) continue; // missing key is fine only if not required by your schema
    const v = obj[k];
    if (v === null) P(`${where}.${k} is null — text fields must be "" for absent, never null`);
    else if (typeof v !== 'string') P(`${where}.${k} is ${typeof v} — must be a string`);
  }
}
function checkNumNonNeg(obj, keys, where) {
  for (const k of keys) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (v === null) continue; // nullable is allowed for numeric fields
    if (typeof v !== 'number' || Number.isNaN(v)) P(`${where}.${k} is ${JSON.stringify(v)} — must be number or null`);
    else if (v < 0) P(`${where}.${k} = ${v} is negative — extraction must be ABSOLUTE (sign comes from doc_type)`);
  }
}

checkText(doc, HEADER_TEXT, 'header');
checkNumNonNeg(doc, HEADER_NUM_NONNEG, 'header');
if ('doc_type' in doc && !DOC_TYPES.includes(doc.doc_type)) P(`header.doc_type "${doc.doc_type}" not in ${DOC_TYPES.join('|')}`);

const lines = Array.isArray(doc.lines) ? doc.lines : [];
lines.forEach((ln, i) => {
  checkText(ln, LINE_TEXT, `lines[${i}]`);
  checkNumNonNeg(ln, LINE_NUM_NONNEG, `lines[${i}]`);
});

console.log(`checked header + ${lines.length} line(s)`);
if (problems.length) {
  console.error(`\nFAIL: ${problems.length} invariant violation(s):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('OK: all invariants hold.');
