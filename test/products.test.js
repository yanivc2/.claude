import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, secretary, firstStore } from './helpers.js';
import { createSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import {
  findProduct,
  upsertProductsFromLines,
  listProducts,
  getProductWithHistory,
} from '../src/services/products.js';
import { toAgorot } from '../src/lib/money.js';

async function twoSuppliers(db) {
  const sec = await secretary(db);
  return {
    sec,
    a: await createSupplier({ name: 'ספק א' }, sec, db),
    b: await createSupplier({ name: 'ספק ב' }, sec, db),
  };
}

/** Line shape as it arrives from a normalized draft. */
function line(over = {}) {
  return { lineNo: 1, name: 'לחם אחיד', barcode: null, sku: null, quantity: 1, unitCost: null, ...over };
}

test('findProduct: barcode beats sku beats normalized name', async () => {
  const db = await freshDb();
  const { a } = await twoSuppliers(db);

  await upsertProductsFromLines(a.id, null, '2026-07-01', [
    line({ lineNo: 1, name: 'מוצר א', barcode: '7290000000011', sku: 'SKU-A' }),
    line({ lineNo: 2, name: 'מוצר ב', sku: 'SKU-B' }),
    line({ lineNo: 3, name: 'מוצר ג' }),
  ], {}, db);

  const byBarcode = await findProduct(a.id, { barcode: '7290000000011', sku: 'SKU-B', name: 'מוצר ג' }, db);
  assert.equal(byBarcode.name, 'מוצר א'); // barcode wins over both

  const bySku = await findProduct(a.id, { barcode: null, sku: 'SKU-B', name: 'מוצר ג' }, db);
  assert.equal(bySku.name, 'מוצר ב'); // sku wins over the name

  const byName = await findProduct(a.id, { name: 'מוצר   ג!' }, db);
  assert.equal(byName.name, 'מוצר ג'); // normalization ignores punctuation/spacing

  assert.equal(await findProduct(a.id, { name: 'לא קיים' }, db), null);
});

test('findProduct never crosses suppliers', async () => {
  const db = await freshDb();
  const { a, b } = await twoSuppliers(db);
  await upsertProductsFromLines(a.id, null, '2026-07-01', [line({ barcode: '7290000000011' })], {}, db);
  assert.ok(await findProduct(a.id, { barcode: '7290000000011' }, db));
  assert.equal(await findProduct(b.id, { barcode: '7290000000011' }, db), null);
});

test('upsert backfills a missing barcode / מק"ט onto the existing row', async () => {
  const db = await freshDb();
  const { a } = await twoSuppliers(db);

  const first = await upsertProductsFromLines(a.id, null, '2026-07-01', [line()], {}, db);
  const productId = first.get(1);
  let row = await db.one('SELECT * FROM products WHERE id = ?', [productId]);
  assert.equal(row.barcode, null);
  assert.equal(row.sku, null);

  const second = await upsertProductsFromLines(
    a.id,
    null,
    '2026-07-02',
    [line({ barcode: '7290000000011', sku: 'LX1' })],
    {},
    db,
  );
  assert.equal(second.get(1), productId); // matched by name, not duplicated
  row = await db.one('SELECT * FROM products WHERE id = ?', [productId]);
  assert.equal(row.barcode, '7290000000011');
  assert.equal(row.sku, 'LX1');
  assert.ok(row.updated_at);

  assert.equal((await db.many('SELECT id FROM products WHERE supplier_id = ?', [a.id])).length, 1);
});

test('upsert appends price history and rolls last_cost forward only for newer invoice dates', async () => {
  const db = await freshDb();
  const { a } = await twoSuppliers(db);

  await upsertProductsFromLines(a.id, null, '2026-07-01', [line({ unitCost: toAgorot('10'), quantity: 4 })], {}, db);
  const productId = (await db.one('SELECT id FROM products WHERE supplier_id = ?', [a.id])).id;
  let row = await db.one('SELECT * FROM products WHERE id = ?', [productId]);
  assert.equal(row.last_cost, 1000);
  assert.equal(row.last_cost_date, '2026-07-01');

  // An older invoice entered late must NOT overwrite the newer price, but is still recorded.
  await upsertProductsFromLines(a.id, null, '2026-06-01', [line({ unitCost: toAgorot('9') })], {}, db);
  row = await db.one('SELECT * FROM products WHERE id = ?', [productId]);
  assert.equal(row.last_cost, 1000);
  assert.equal(row.last_cost_date, '2026-07-01');

  await upsertProductsFromLines(a.id, null, '2026-08-01', [line({ unitCost: toAgorot('12') })], {}, db);
  row = await db.one('SELECT * FROM products WHERE id = ?', [productId]);
  assert.equal(row.last_cost, 1200);
  assert.equal(row.last_cost_date, '2026-08-01');

  const prices = await db.many('SELECT * FROM product_prices WHERE product_id = ? ORDER BY id', [productId]);
  assert.deepEqual(prices.map((p) => p.price), [1000, 900, 1200]);
  assert.equal(Number(prices[0].quantity), 4);
});

test('upsert skips nameless lines and lines without a unit cost get no price row', async () => {
  const db = await freshDb();
  const { a } = await twoSuppliers(db);
  const map = await upsertProductsFromLines(
    a.id,
    null,
    '2026-07-01',
    [line({ lineNo: 1, name: null }), line({ lineNo: 2, name: 'חלה', unitCost: null })],
    {},
    db,
  );
  assert.equal(map.has(1), false);
  assert.ok(map.get(2));
  assert.equal((await db.many('SELECT id FROM product_prices', [])).length, 0);
});

test('upsert with recordPrices=false links products without touching price history', async () => {
  const db = await freshDb();
  const { a } = await twoSuppliers(db);
  await upsertProductsFromLines(a.id, null, '2026-07-01', [line({ unitCost: toAgorot('10') })], {}, db);
  await upsertProductsFromLines(
    a.id,
    null,
    '2026-09-01',
    [line({ unitCost: toAgorot('99') })],
    { recordPrices: false },
    db,
  );
  const row = await db.one('SELECT * FROM products WHERE supplier_id = ?', [a.id]);
  assert.equal(row.last_cost, 1000); // unchanged
  assert.equal((await db.many('SELECT id FROM product_prices', [])).length, 1);
});

test('listProducts searches name / barcode / מק"ט and filters by supplier', async () => {
  const db = await freshDb();
  const { a, b } = await twoSuppliers(db);
  await upsertProductsFromLines(a.id, null, '2026-07-01', [
    line({ lineNo: 1, name: 'לחם אחיד פרוס', barcode: '7290000000011', sku: 'LX1' }),
    line({ lineNo: 2, name: 'חלב 3%', barcode: '7290000000028', sku: 'ML9' }),
  ], {}, db);
  await upsertProductsFromLines(b.id, null, '2026-07-01', [line({ name: 'לחם כפרי' })], {}, db);

  assert.equal((await listProducts({}, db)).length, 3);
  assert.equal((await listProducts({ supplierId: a.id }, db)).length, 2);
  assert.deepEqual((await listProducts({ q: 'לחם' }, db)).map((p) => p.name).sort(), ['לחם אחיד פרוס', 'לחם כפרי']);
  assert.deepEqual((await listProducts({ q: '0000002' }, db)).map((p) => p.name), ['חלב 3%']);
  assert.deepEqual((await listProducts({ q: 'ML9' }, db)).map((p) => p.name), ['חלב 3%']);
  assert.equal((await listProducts({ q: 'LX1', supplierId: b.id }, db)).length, 0);
  assert.ok((await listProducts({ q: 'לחם' }, db))[0].supplier_name); // supplier joined in
});

test('getProductWithHistory returns the price history newest first, with invoice numbers', async () => {
  const db = await freshDb();
  const sec = await secretary(db);
  const st = await firstStore(db);
  const sup = await createSupplier({ name: 'ספק א' }, sec, db);
  const { invoice } = await createInvoice(
    {
      supplierId: sup.id,
      storeId: st.id,
      invoiceNumber: '555',
      invoiceDate: '2026-08-01',
      amountBeforeVat: toAgorot('100'),
      vatAmount: toAgorot('18'),
      docType: 'tax_invoice',
    },
    sec,
    db,
  );

  await upsertProductsFromLines(sup.id, null, '2026-06-01', [line({ unitCost: toAgorot('8') })], {}, db);
  await upsertProductsFromLines(sup.id, invoice.id, '2026-08-01', [line({ unitCost: toAgorot('12') })], {}, db);

  const productId = (await db.one('SELECT id FROM products WHERE supplier_id = ?', [sup.id])).id;
  const { product, prices } = await getProductWithHistory(productId, db);
  assert.equal(product.supplier_name, 'ספק א');
  assert.equal(product.last_cost, 1200);
  assert.deepEqual(prices.map((p) => p.price), [1200, 800]); // newest first
  assert.equal(prices[0].invoice_number, '555');
  assert.equal(prices[1].invoice_number, null);

  await assert.rejects(getProductWithHistory(99999, db), /לא נמצא/);
});
