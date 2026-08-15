import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import {
  importCatalogItems,
  lookupByBarcodes,
  listManufacturers,
  listCatalog,
  catalogStats,
  exportGrouped,
  lookupByCodes,
} from '../src/services/masterCatalog.js';

function item(over = {}) {
  return {
    barcode: '7290000000015',
    name: 'חלב תנובה 3%',
    manufacturerName: 'תנובה בע"מ',
    unitQty: 'ליטר',
    quantity: 1,
    qtyInPackage: 12,
    retailPrice: 690,
    ...over,
  };
}

test('importCatalogItems: insert, unchanged re-import, changed update', async () => {
  const db = await freshDb();

  const first = await importCatalogItems(
    [item(), item({ barcode: '4006381333931', name: 'מרקר', manufacturerName: 'Stabilo', retailPrice: 1290 })],
    { chain: 'shufersal', store: '5' },
    db,
  );
  assert.deepEqual(first, { inserted: 2, updated: 0, unchanged: 0 });

  // Same content again — nothing rewritten.
  const again = await importCatalogItems([item()], {}, db);
  assert.deepEqual(again, { inserted: 0, updated: 0, unchanged: 1 });

  // A changed retail price updates in place (same barcode, no duplicate row).
  const changed = await importCatalogItems([item({ retailPrice: 750 })], {}, db);
  assert.deepEqual(changed, { inserted: 0, updated: 1, unchanged: 0 });

  const rows = await db.many('SELECT * FROM master_catalog ORDER BY barcode', []);
  assert.equal(rows.length, 2);
  const milk = rows.find((r) => r.barcode === '7290000000015');
  assert.equal(Number(milk.retail_price), 750);
  assert.equal(milk.manufacturer_norm, 'תנובה'); // normalizeSupplierName dropped בע"מ
  assert.equal(milk.source_chain, 'shufersal');
});

test('importing in batches lands the same catalog as importing in one go', async () => {
  // The browser streams a large workbook in as a series of batches, so this equivalence is the
  // property that makes it safe. It also covers the retry story: a run that stops halfway can be
  // repeated from the start, because every row is an upsert.
  const rows = Array.from({ length: 50 }, (_, i) =>
    item({ barcode: `729000000${String(i).padStart(4, '0')}`, name: `מוצר ${i}`, retailPrice: 100 + i }),
  );

  const whole = await freshDb();
  await importCatalogItems(rows, { chain: 'קובץ', store: null }, whole);

  const batched = await freshDb();
  let inserted = 0;
  for (let i = 0; i < rows.length; i += 10) {
    const res = await importCatalogItems(rows.slice(i, i + 10), { chain: 'קובץ', store: null }, batched);
    inserted += res.inserted;
  }
  assert.equal(inserted, 50);

  const shape = (x) => x.many('SELECT barcode, name, retail_price, source_chain FROM master_catalog ORDER BY barcode', []);
  assert.deepEqual(await shape(batched), await shape(whole));

  // Re-running a batch that already landed touches nothing.
  const repeat = await importCatalogItems(rows.slice(0, 10), { chain: 'קובץ', store: null }, batched);
  assert.deepEqual(repeat, { inserted: 0, updated: 0, unchanged: 10 });
});

test('the existing-row lookup reads only the barcodes being imported', async () => {
  // It used to SELECT the whole table on every call, which is fine once and pathological when a
  // browser feeds the same table 40 batches in a row.
  const db = await freshDb();
  await importCatalogItems(
    Array.from({ length: 200 }, (_, i) => item({ barcode: `729000000${String(i).padStart(4, '0')}` })),
    {},
    db,
  );

  const seen = [];
  const spy = { ...db, many: async (sql, params) => { seen.push({ sql, params }); return db.many(sql, params); } };
  await importCatalogItems([item({ barcode: '7290000000005', name: 'שם חדש' })], {}, spy);

  const lookups = seen.filter((q) => /FROM master_catalog/.test(q.sql));
  assert.equal(lookups.length, 1);
  assert.match(lookups[0].sql, /WHERE barcode IN \(\?\)/);
  assert.deepEqual(lookups[0].params, ['7290000000005']);
});

test('duplicate barcodes inside one import: first occurrence wins', async () => {
  const db = await freshDb();
  const res = await importCatalogItems([item({ name: 'ראשון' }), item({ name: 'שני' })], {}, db);
  assert.deepEqual(res, { inserted: 1, updated: 0, unchanged: 0 });
  const row = await db.one('SELECT name FROM master_catalog WHERE barcode = ?', ['7290000000015']);
  assert.equal(row.name, 'ראשון');
});

test('lookupByBarcodes returns a map of only the found codes; empty input → empty map', async () => {
  const db = await freshDb();
  await importCatalogItems([item()], {}, db);

  const found = await lookupByBarcodes(['7290000000015', '96385074', '', null], db);
  assert.equal(found.size, 1);
  assert.equal(found.get('7290000000015').name, 'חלב תנובה 3%');

  assert.equal((await lookupByBarcodes([], db)).size, 0);
  assert.equal((await lookupByBarcodes(null, db)).size, 0);
});

test('listManufacturers groups and counts; listCatalog filters; stats add up', async () => {
  const db = await freshDb();
  await importCatalogItems(
    [
      item(),
      item({ barcode: '7290000000022', name: 'גבינה לבנה' }),
      item({ barcode: '4006381333931', name: 'מרקר', manufacturerName: 'Stabilo' }),
      item({ barcode: '96385074', name: 'ללא יצרן', manufacturerName: null }),
    ],
    {},
    db,
  );

  const mans = await listManufacturers(db);
  assert.equal(mans.length, 2); // null manufacturer excluded
  assert.equal(mans[0].manufacturer_name, 'תנובה בע"מ');
  assert.equal(Number(mans[0].count), 2);

  const tnuva = await listCatalog({ manufacturer: 'תנובה' }, db);
  assert.equal(tnuva.length, 2);
  const search = await listCatalog({ q: 'מרקר' }, db);
  assert.equal(search.length, 1);
  assert.equal(search[0].barcode, '4006381333931');

  const stats = await catalogStats(db);
  assert.equal(stats.items, 4);
  assert.equal(stats.manufacturers, 2);
  assert.ok(stats.lastImport);
});

test('exportGrouped: the "מאסטר קטלוג לפי ספקים" deliverable shape', async () => {
  const db = await freshDb();
  await importCatalogItems(
    [item(), item({ barcode: '7290000000022', name: 'גבינה' }), item({ barcode: '96385074', name: 'X', manufacturerName: null })],
    {},
    db,
  );
  const out = await exportGrouped(db);
  assert.equal(out.itemCount, 3);
  assert.equal(out.sourceChain, 'shufersal');
  assert.equal(out.manufacturers[0].manufacturer, 'תנובה בע"מ'); // biggest first
  assert.equal(out.manufacturers[0].itemCount, 2);
  assert.deepEqual(
    out.manufacturers.map((m) => m.manufacturer).includes('ללא יצרן'),
    true,
  );
  const milk = out.manufacturers[0].items.find((i) => i.barcode === '7290000000015');
  assert.equal(milk.retailPrice, 690);
  assert.equal(milk.qtyInPackage, 12);
});

test('lookupByCodes resolves a shortened barcode to the full EAN', async () => {
  const db = await freshDb();
  // The three products the real Tnuva invoice prints as 42435 / 16930695 / 4136857, plus a
  // decoy that shares a short tail so ambiguity is exercised on real-shaped data.
  await importCatalogItems(
    [
      { barcode: '7290000042435', name: 'חלב מפוסטר 1% בקרטון 1ל', manufacturerName: 'תנובה בע"מ', retailPrice: 599 },
      { barcode: '7290116930695', name: 'חלב נטול לקטוז 2% 1ל', manufacturerName: 'תנובה בע"מ', retailPrice: 899 },
      { barcode: '7290004136857', name: 'גלי פטל 125 גרם', manufacturerName: 'סוי מגיק', retailPrice: 450 },
      { barcode: '7291114136857', name: 'מוצר אחר עם אותה סיומת', manufacturerName: 'אחר', retailPrice: 100 },
    ],
    {},
    db,
  );

  const map = await lookupByCodes(['42435', '16930695', '4136857'], db);
  assert.equal(map.get('42435').length, 1);
  assert.equal(map.get('42435')[0].name, 'חלב מפוסטר 1% בקרטון 1ל');
  assert.equal(map.get('16930695')[0].barcode, '7290116930695');
  // Two catalog barcodes end with 4136857 — both are returned; picking is a human's job.
  assert.equal(map.get('4136857').length, 2);
});

test('lookupByCodes ignores codes too short to identify anything', async () => {
  const db = await freshDb();
  await importCatalogItems([{ barcode: '7290000042435', name: 'חלב', retailPrice: 599 }], {}, db);
  // 5 digits is ambiguous for ~15% of a real catalog, so it is not looked up at all.
  assert.equal((await lookupByCodes(['2435'], db)).size, 0);
  assert.equal((await lookupByCodes(['42435'], db)).size, 1);
  assert.equal((await lookupByCodes(['', null, 'ABC123'], db)).size, 0);
});
