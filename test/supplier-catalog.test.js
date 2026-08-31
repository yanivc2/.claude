import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshDb } from './helpers.js';
import { parseSupplierCatalog, baseName, PACK_BOX, PACK_CARTON } from '../src/lib/supplierCatalogFile.js';
import { buildSupplierIndex, matchLine, resolvePack } from '../src/lib/supplierCatalogMatch.js';
import { validateExtraction } from '../src/lib/extractValidate.js';
import {
  importSupplierCatalog,
  catalogForSupplier,
  supplierCatalogSummary,
  clearSupplierCatalog,
} from '../src/services/supplierCatalog.js';

// Known-answer tests for identifying a line on a TOBACCO invoice.
//
// The fixture is the three real catalogs the suppliers themselves handed over — מוצרי איכות
// קנדים (51 rows), פיליפ מוריס (94) and גלוברנדס (108) — parsed by the shipped parser. Two of
// those suppliers print invoices with no barcode column at all, and גלוברנדס prints a "פריט"
// column that is its own 4-digit item number, so these files are the only thing that can turn
// their invoice lines into identified products.

const CATALOGS = JSON.parse(
  fs.readFileSync(new URL('./fixtures/tobacco-supplier-catalogs.json', import.meta.url), 'utf8'),
);
const CANADIAN = 'מוצרי איכות קנדים בע"מ';
const PHILIP = 'פיליפ מוריס בע"מ';
const GLOBRANDS = 'גלוברנדס בע"מ';

/** The fixture's items shaped like DB rows (snake_case), for the matcher. */
function indexOf(supplier) {
  return buildSupplierIndex(
    CATALOGS[supplier].items.map((i) => ({
      ...i,
      name_norm: i.nameNorm,
      pack_type: i.packType,
      pack_units: i.packUnits,
      linked_barcode: i.linkedBarcode,
    })),
  );
}

/** The seed ships no suppliers; these catalogs each belong to one. */
async function makeSupplier(x, name) {
  const info = await x.run("INSERT INTO suppliers (name, status) VALUES (?, 'approved')", [name]);
  return x.one('SELECT * FROM suppliers WHERE id = ?', [info.lastInsertRowid]);
}

test('the fixture is the real thing: every barcode valid, every product a קופסה/פאקט pair', () => {
  assert.equal(CATALOGS[CANADIAN].items.length, 51);
  assert.equal(CATALOGS[PHILIP].items.length, 94);
  assert.equal(CATALOGS[GLOBRANDS].items.length, 108);
  // Nothing was skipped and no barcode failed its check digit — the parser rejects rather than
  // repairs here, so a non-zero skip count would mean a file that needs another look.
  for (const supplier of [CANADIAN, PHILIP, GLOBRANDS]) {
    assert.equal(CATALOGS[supplier].stats.skipped, 0, `${supplier} skipped nothing`);
  }
  assert.equal(CATALOGS[GLOBRANDS].stats.products, 54);
  assert.equal(CATALOGS[PHILIP].stats.products, 47);
});

test('גלוברנדס: the "פריט" column is a 4-digit item number shared by both packagings', () => {
  const items = CATALOGS[GLOBRANDS].items;
  assert.equal(items.filter((i) => i.sku).length, 108, 'every row carries a מק"ט');
  assert.ok(items.every((i) => i.sku.length === 4), 'all four digits — below MIN_SUFFIX_LEN of 5');

  // 54 distinct numbers over 108 rows: each one covers exactly one קופסה and one פאקט. This is
  // why a מק"ט identifies the PRODUCT and never the LINE.
  const bySku = new Map();
  for (const i of items) {
    if (!bySku.has(i.sku)) bySku.set(i.sku, []);
    bySku.get(i.sku).push(i);
  }
  assert.equal(bySku.size, 54);
  for (const [sku, group] of bySku) {
    assert.deepEqual(
      group.map((g) => g.packType).sort(),
      [PACK_CARTON, PACK_BOX].sort(),
      `מק"ט ${sku} covers exactly one קופסה and one פאקט`,
    );
  }
});

test('the base name is a unique key inside a supplier — which is what makes name matching safe', () => {
  for (const supplier of [CANADIAN, PHILIP, GLOBRANDS]) {
    const byBase = new Map();
    for (const i of CATALOGS[supplier].items) {
      if (!byBase.has(i.nameNorm)) byBase.set(i.nameNorm, []);
      byBase.get(i.nameNorm).push(i);
    }
    for (const [name, group] of byBase) {
      const packs = group.map((g) => g.packType);
      assert.equal(new Set(packs).size, packs.length, `${supplier}: "${name}" has one row per packaging`);
    }
  }
});

test('baseName strips the packaging word and reports it', () => {
  assert.deepEqual(baseName('פאקט מרלבורו אדום'), { base: 'מרלבורו אדום', pack: PACK_CARTON });
  assert.deepEqual(baseName('מרלבורו אדום'), { base: 'מרלבורו אדום', pack: null });
  // The catalog always prefixes it; an invoice line is free to put it anywhere.
  assert.deepEqual(baseName('מרלבורו אדום פאקט'), { base: 'מרלבורו אדום', pack: PACK_CARTON });
});

test('גלוברנדס: a printed פריט resolves to a product, and the packaging is decided separately', () => {
  const idx = indexOf(GLOBRANDS);

  // The description names the קופסה exactly and nothing contradicts it.
  const box = matchLine({ sku: '6100', name: 'וינסטון כחול בוקס' }, idx);
  assert.equal(box.method, 'sku');
  assert.equal(box.row.barcode, '7290121290036');
  assert.equal(box.row.pack_type, PACK_BOX);

  // The same item number, the carton's name.
  const carton = matchLine({ sku: '6100', name: 'פאקט וינסטון כחול בוקס' }, idx);
  assert.equal(carton.row.barcode, '7290121290043');
  assert.equal(carton.row.pack_type, PACK_CARTON);

  // Suppliers do not agree on which column the code goes in, so both are tried.
  const viaBarcodeColumn = matchLine({ barcode: '6101', name: 'וינסטון אדום' }, idx);
  assert.equal(viaBarcodeColumn.method, 'sku');
  assert.equal(viaBarcodeColumn.row.barcode, '7290121290005');
});

test('a full printed barcode wins outright, description or not', () => {
  const idx = indexOf(GLOBRANDS);
  const hit = matchLine({ barcode: '7290121290043', name: 'משהו אחר לגמרי' }, idx);
  assert.equal(hit.method, 'barcode');
  assert.equal(hit.row.pack_type, PACK_CARTON);
  assert.equal(hit.packAmbiguous, false);
});

test('פיליפ מוריס / קנדים: the name alone identifies the line, packaging included', () => {
  const pm = indexOf(PHILIP);
  const gold = matchLine({ name: 'מרלבורו גולד' }, pm);
  assert.equal(gold.method, 'name');
  assert.equal(gold.row.barcode, '7290115190090');
  assert.equal(gold.row.pack_type, PACK_BOX);

  const goldCarton = matchLine({ name: 'פאקט מרלבורו גולד' }, pm);
  assert.equal(goldCarton.row.barcode, '7290115190083');
  assert.equal(goldCarton.row.pack_type, PACK_CARTON);

  // `מרלבורו גולד` and `מרלבורו גולד 100` are different products one word apart; the extra word
  // must not be shrugged off.
  const hundred = matchLine({ name: 'מרלבורו גולד 100' }, pm);
  assert.equal(hundred.row.barcode, '7290115190076');

  const can = indexOf(CANADIAN);
  const pine = matchLine({ name: 'פיין בלו ארוך' }, can);
  assert.equal(pine.row.barcode, '8801116008735');
  assert.equal(pine.row.pack_type, PACK_BOX);
});

test('a one-letter misreading still resolves — the name is the only identifier these invoices have', () => {
  const pm = indexOf(PHILIP);
  const near = matchLine({ name: 'מרלברו גולד' }, pm); // מרלבורו, one letter short
  assert.equal(near.method, 'name_fuzzy');
  assert.equal(near.row.barcode, '7290115190090');
  assert.equal(near.row.pack_type, PACK_BOX, 'and the packaging survives the near-miss');
});

test('a description that matches nothing matches NOTHING', () => {
  const pm = indexOf(PHILIP);
  assert.equal(matchLine({ name: 'חלב 3% תנובה' }, pm).row, null);
  // A bare brand covers 20+ products; picking one would be a coin flip dressed as an answer.
  assert.equal(matchLine({ name: 'מרלבורו' }, pm).row, null);
  assert.equal(matchLine({ name: '' }, pm).row, null);
});

test('the packaging trap: contradictory evidence is reported, never resolved by guessing', () => {
  const idx = indexOf(GLOBRANDS);

  // The description is the קופסה's name, but 5 units of 50 singles means cartons of 10. Picking
  // either silently would be a 10× error in the unit cost that reaches the price history.
  const conflicted = matchLine(
    { sku: '6100', name: 'וינסטון כחול בוקס', quantity: 5, unitQuantity: 50 },
    idx,
  );
  assert.equal(conflicted.row, null);
  assert.equal(conflicted.packConflict, true);
  assert.equal(conflicted.product.length, 2, 'both packagings are offered to the human');

  // When the two agree, the line resolves and says so.
  const agree = matchLine(
    { sku: '6100', name: 'פאקט וינסטון כחול בוקס', quantity: 5, unitQuantity: 50 },
    idx,
  );
  assert.equal(agree.row.pack_type, PACK_CARTON);
  assert.match(agree.packBy, /ratio/);
  assert.equal(agree.packConflict, false);
});

test('כ.בודד ÷ כמות alone decides the packaging when the description is silent', () => {
  const pair = [
    { name: 'וינסטון אדום', pack_type: PACK_BOX, pack_units: 1, barcode: 'A' },
    { name: 'פאקט וינסטון אדום', pack_type: PACK_CARTON, pack_units: 10, barcode: 'B' },
  ];
  // No name at all — only the arithmetic on the line.
  assert.equal(resolvePack(pair, { name: null, quantity: 5, unitQuantity: 50 }).row.barcode, 'B');
  assert.equal(resolvePack(pair, { name: null, quantity: 5, unitQuantity: 5 }).row.barcode, 'A');
  // Nothing to go on at all: no guess.
  const blind = resolvePack(pair, { name: null });
  assert.equal(blind.row, null);
  assert.equal(blind.conflict, false);
});

test('parsing rejects a bad check digit instead of repairing it', () => {
  // 7290115190091 is מרלבורו גולד's barcode with the check digit changed.
  const csv = 'ברקוד,שם מוצר,סוג אריזה,יח\' אריזה\n7290115190091,מרלבורו גולד,קופסה,1\n7290115190090,מרלבורו גולד,קופסה,1\n';
  const { items, warnings } = parseSupplierCatalog(csv);
  assert.equal(items.length, 1);
  assert.equal(items[0].barcode, '7290115190090');
  assert.match(warnings.join(' '), /ספרת הביקורת/);
});

test('import replaces a supplier catalog rather than merging into it', async () => {
  const x = await freshDb();
  const supplier = await makeSupplier(x, GLOBRANDS);

  const first = await importSupplierCatalog(supplier.id, CATALOGS[GLOBRANDS].items, x);
  assert.equal(first.imported, 108);
  assert.equal(first.replaced, 0);
  assert.equal((await catalogForSupplier(supplier.id, x)).length, 108);

  // A later, smaller file is the supplier's CURRENT range — the items it dropped must go.
  const second = await importSupplierCatalog(supplier.id, CATALOGS[GLOBRANDS].items.slice(0, 10), x);
  assert.equal(second.imported, 10);
  assert.equal(second.replaced, 108);
  const rows = await catalogForSupplier(supplier.id, x);
  assert.equal(rows.length, 10);

  const summary = await supplierCatalogSummary(x);
  assert.equal(Number(summary[0].row_count), 10);

  await clearSupplierCatalog(supplier.id, x);
  assert.equal((await catalogForSupplier(supplier.id, x)).length, 0);
});

test('a catalog loaded through the DB matches exactly as the fixture does', async () => {
  const x = await freshDb();
  const supplier = await makeSupplier(x, PHILIP);
  await importSupplierCatalog(supplier.id, CATALOGS[PHILIP].items, x);

  // The round trip through SQL is where a column rename or a lost name_norm would show up.
  const idx = buildSupplierIndex(await catalogForSupplier(supplier.id, x));
  const gold = matchLine({ name: 'פאקט מרלבורו גולד' }, idx);
  assert.equal(gold.row.barcode, '7290115190083');
  assert.equal(gold.row.pack_type, PACK_CARTON);
  assert.equal(gold.row.pack_units, 10);
});

// ── the review draft ─────────────────────────────────────────────────────────
// The catalog only earns its keep if a scanned line comes back identified, so these run the real
// validator over the real catalogs.

test('validateExtraction identifies a barcode-less tobacco line through the supplier catalog', () => {
  const idx = indexOf(PHILIP);
  const out = validateExtraction(
    {
      supplier_name: PHILIP, invoice_number: '123', invoice_date: '2026-08-30',
      doc_type: 'tax_invoice', amount_before_vat: 100, vat_amount: 18, total_amount: 118,
      lines: [
        // No barcode, no מק"ט — exactly what these invoices print.
        { name: 'פאקט מרלבורו גולד', barcode: '', sku: '', quantity: 2, unit_cost: 280, line_total: 560 },
        { name: 'מרלבורו אדום', barcode: '', sku: '', quantity: 4, unit_cost: 28, line_total: 112 },
      ],
      field_confidence: {}, notes: '',
    },
    { suppliers: [], vatRate: 0.18, masterCatalog: null, supplierCatalog: idx },
  );

  assert.ok(out.lines[0].flags.includes('supplier_catalog_match'));
  assert.equal(out.lines[0].catalog.barcode, '7290115190083');
  assert.equal(out.lines[0].catalog.packType, PACK_CARTON);
  assert.equal(out.lines[0].catalog.source, 'supplier');

  assert.equal(out.lines[1].catalog.barcode, '7290115190014');
  assert.equal(out.lines[1].catalog.packType, PACK_BOX);

  // Nothing was written over what the model read — the catalog offers, a human adopts.
  assert.equal(out.lines[0].barcode, null);
  assert.equal(out.lines[0].name, 'פאקט מרלבורו גולד');
});

test('a packaging conflict reaches the draft as a flag, with both options attached', () => {
  const out = validateExtraction(
    {
      supplier_name: GLOBRANDS, invoice_number: '1', invoice_date: '2026-08-30',
      doc_type: 'tax_invoice', amount_before_vat: 100, vat_amount: 18, total_amount: 118,
      // The description is the קופסה's name; 5 units of 50 singles says cartons of 10.
      lines: [{ name: 'וינסטון כחול בוקס', sku: '6100', quantity: 5, unit_quantity: 50, line_total: 1400 }],
      field_confidence: {}, notes: '',
    },
    { suppliers: [], vatRate: 0.18, masterCatalog: null, supplierCatalog: indexOf(GLOBRANDS) },
  );
  const line = out.lines[0];
  assert.ok(line.flags.includes('supplier_catalog_conflict'));
  assert.equal(line.catalog, null, 'nothing is adopted while the evidence disagrees');
  assert.equal(line.candidates.length, 2, 'both packagings are on the screen to choose from');
});

test('a line the supplier catalog cannot place still falls through to the master catalog', () => {
  // The supplier catalog is consulted first, but it must not swallow lines it knows nothing
  // about — the master-catalog path has to behave exactly as it did before.
  const rows = [{ barcode: '7290000042435', name: 'חלב דל שומן 1%', manufacturer_name: 'תנובה' }];
  const out = validateExtraction(
    {
      supplier_name: 'תנובה', invoice_number: '1', invoice_date: '2026-08-30',
      doc_type: 'tax_invoice', amount_before_vat: 100, vat_amount: 18, total_amount: 118,
      lines: [{ name: 'הומוגני 1% דל', barcode: '42435', quantity: 1, unit_cost: 5, line_total: 5 }],
      field_confidence: {}, notes: '',
    },
    {
      suppliers: [], vatRate: 0.18,
      masterCatalog: { exact: new Map(), byCode: new Map([['42435', rows]]) },
      supplierCatalog: indexOf(PHILIP), // a catalog that has nothing to do with this line
    },
  );
  assert.ok(out.lines[0].flags.includes('catalog_suffix_match'));
  assert.equal(out.lines[0].catalog.barcode, '7290000042435');
});

test('a header broken by a bare double-quote is reported, not imported quietly', () => {
  // `מק"ט` written without doubling the quote is read as an opening quote that swallows the
  // commas after it, so the header splits into fewer fields than the rows and every column past
  // it shifts. The row COUNT stays right, which is what makes it dangerous.
  const broken = 'ברקוד,שם מוצר,מק"ט,סוג אריזה,יח\' אריזה\n7290121290036,וינסטון כחול בוקס,6100,קופסה,1\n';
  const bad = parseSupplierCatalog(broken);
  assert.equal(bad.items.length, 1, 'the rows still parse — that is the trap');
  assert.equal(bad.items[0].sku, null, '…while the columns after the break are empty');
  assert.match(bad.warnings.join(' '), /שורת הכותרות/);

  // Correctly quoted, the same file reads in full and says nothing.
  const good = 'ברקוד,שם מוצר,"מק""ט",סוג אריזה,יח\' אריזה\n7290121290036,וינסטון כחול בוקס,6100,קופסה,1\n';
  const ok = parseSupplierCatalog(good);
  assert.equal(ok.items[0].sku, '6100');
  assert.equal(ok.items[0].packType, 'קופסה');
  assert.deepEqual(ok.warnings, []);
});
