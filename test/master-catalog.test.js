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
