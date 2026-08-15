import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateExtraction, rankCandidates } from '../src/lib/extractValidate.js';

// The known-answer test for product identification.
//
// The fixture is not invented: it is the real catalog rows for the 30 codes printed on a real
// Tnuva invoice (photographed by the owner), pulled from their own 80,411-item four-chain
// catalog. The printed descriptions are the ones on that invoice. So this asserts what the
// feature is actually for — that a supplier who prints a shortened barcode still gets its
// products identified — against the document that motivated it.
//
// Measured on that catalog, for context on why the rules are shaped as they are:
//   a 5-digit code identifies one product 64.5% of the time, 6 digits 94.3%, 7 digits 99.4%
//   97% of ambiguous groups hold products whose names have nothing in common

const CATALOG = JSON.parse(fs.readFileSync(new URL('./fixtures/tnuva-invoice-codes.json', import.meta.url), 'utf8'));

/** The printed code → description, as they appear on the invoice photo. */
const PRINTED = {
  42435: 'הומוגני 1% דל',
  16930695: 'חלב נטול לקטוז 2%',
  4136857: 'ג׳לי פטל תנובה',
  43890: 'רויון 1 ליטר',
  44248: 'רויון 500',
  4120061: 'קרלו 125 1.5%',
  72961544: 'נאו חי 125',
  14761070: 'YOLO',
};

function lineFor(code) {
  const rows = CATALOG[code];
  const out = validateExtraction(
    {
      supplier_name: 'תנובה', supplier_tax_id: '', supplier_phone: '', invoice_number: '626093611',
      allocation_number: '', invoice_date: '2026-08-06', doc_type: 'tax_invoice',
      amount_before_vat: 100, vat_amount: 18, total_amount: 118,
      lines: [{
        name: PRINTED[code] || 'פריט', barcode: code, sku: '', quantity: 1, unit_quantity: null,
        unit_cost: 5, pack_cost: null, line_total: 5, confidence: 'high',
      }],
      field_confidence: {}, notes: '',
    },
    { suppliers: [], vatRate: 0.18, masterCatalog: { exact: new Map(), byCode: new Map([[code, rows]]) } },
  );
  return out.lines[0];
}

test('the fixture is the real catalog: 30 printed codes, 28 of them unique', () => {
  const codes = Object.keys(CATALOG);
  assert.equal(codes.length, 30);
  const sizes = codes.map((c) => CATALOG[c].length);
  assert.equal(sizes.filter((n) => n === 1).length, 28);
  assert.equal(sizes.filter((n) => n > 1).length, 2);
  assert.equal(sizes.filter((n) => n === 0).length, 0);
});

test('every printed code on the real invoice resolves to exactly one product, and none wrongly', () => {
  const resolved = [];
  const unresolved = [];
  for (const code of Object.keys(CATALOG)) {
    const line = lineFor(code);
    if (line.flags.includes('catalog_suffix_match')) resolved.push(code);
    else unresolved.push(code);
  }
  // 28 unique + the 2 ambiguous ones the ranking settles = all 30. If this ever drops, the
  // matcher got more conservative and a human is now doing work the catalog used to do.
  assert.deepEqual(unresolved, []);
  assert.equal(resolved.length, 30);
});

test('the two genuinely ambiguous codes pick the Tnuva product, not the dinner set', () => {
  // `42435` → {סט אוכל 12 חלקים, חלב דל שומן · תנובה, קונפיטורה אפרסק}
  // `43890` → {אצבעות אנטריקוט, כפפות ניטריל · שניב, רויון 1.5% · תנובה}
  // Both are three unrelated products sharing a code tail — the invoice's own description and
  // its supplier are what separate them.
  const milk = lineFor('42435');
  assert.equal(milk.catalog.barcode, '7290000042435');
  assert.match(milk.catalog.name, /חלב/);
  assert.equal(milk.candidates.length, 3);
  assert.equal(milk.candidates[0].barcode, '7290000042435'); // ranked first for a human to confirm

  const ryon = lineFor('43890');
  assert.equal(ryon.catalog.barcode, '7290000043890');
  assert.match(ryon.catalog.name, /רויון/);
});

test('a 7-digit code is marked near-certain, a 5-digit one is not', () => {
  assert.equal(lineFor('4136857').catalog.nearCertain, true);
  assert.equal(lineFor('42435').catalog.nearCertain, false);
});

test('nothing is ever written over the extraction', () => {
  // The whole design rule: the catalog offers, a human adopts with a click. A match that quietly
  // rewrote the barcode would make a wrong match invisible.
  for (const code of Object.keys(CATALOG)) {
    const line = lineFor(code);
    assert.equal(line.barcode, code, `line ${code} kept its printed code`);
  }
});

test('ranking is stable and explains itself', () => {
  const rows = CATALOG['42435'];
  const ranked = rankCandidates(rows, { printedName: 'הומוגני 1% דל', supplierName: 'תנובה' });
  assert.equal(ranked[0].row.barcode, '7290000042435');
  assert.equal(ranked[0].bySupplier, true);
  assert.ok(ranked[0].byName > 0, 'the description overlaps the winning name');
  assert.ok(ranked[1].score < ranked[0].score - 0.12, 'and the runner-up is not close');

  // Without the supplier the name alone still decides — 97% of ambiguous groups are this shape.
  const nameOnly = rankCandidates(rows, { printedName: 'הומוגני 1% דל' });
  assert.equal(nameOnly[0].row.barcode, '7290000042435');
});
