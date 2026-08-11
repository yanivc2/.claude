import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { freshDb, owner } from './helpers.js';
import { config } from '../src/config.js';
import { exportAll, resetTransactionalData, restoreAll } from '../src/services/backup.js';

async function seedTransactional(db, ow) {
  const store = await db.one('SELECT id, company_id FROM stores LIMIT 1', []);
  const ba = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [store.id]);
  const sup = await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק','approved')", []);
  const inv = await db.run(
    `INSERT INTO invoices (supplier_id, company_id, store_id, invoice_number, invoice_date,
       amount_before_vat, vat_amount, total_amount, doc_type, status, created_by)
     VALUES (?,?,?, 'X1', '2026-07-01', 1000, 180, 1180, 'tax_invoice', 'recorded', ?)`,
    [sup.lastInsertRowid, store.company_id, store.id, ow.id],
  );
  const pay = await db.run(
    `INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by)
     VALUES (?, 'check', '1', '2026-07-01', 1180, 'issued', ?)`,
    [ba.id, ow.id],
  );
  await db.run('INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, ?)', [
    pay.lastInsertRowid, inv.lastInsertRowid, 1180,
  ]);
}

// Scan/catalog rows (צילום חשבוניות): a product + its price history, an invoice line and a
// draft whose `images` is a JSON array of storage refs. Call after seedTransactional().
async function seedScanData(db, ow, imageRefs = ['page-1.jpg']) {
  const store = await db.one('SELECT id, company_id FROM stores LIMIT 1', []);
  const sup = await db.one('SELECT id FROM suppliers ORDER BY id LIMIT 1', []);
  const inv = await db.one('SELECT id FROM invoices ORDER BY id LIMIT 1', []);
  const prod = await db.run(
    `INSERT INTO products (supplier_id, name, barcode, sku, last_cost, last_cost_date)
     VALUES (?, 'קמח 1 ק"ג', '7290000000017', 'MK-1', 550, '2026-07-01')`,
    [sup.id],
  );
  await db.run(
    'INSERT INTO product_prices (product_id, invoice_id, price, quantity, price_date) VALUES (?,?,?,?,?)',
    [prod.lastInsertRowid, inv.id, 550, 2, '2026-07-01'],
  );
  await db.run(
    `INSERT INTO invoice_lines (invoice_id, product_id, line_no, name, barcode, sku, quantity,
       unit_cost, unit_cost_source, line_total)
     VALUES (?,?, 1, 'קמח 1 ק"ג', '7290000000017', 'MK-1', 2, 550, 'extracted', 1100)`,
    [inv.id, prod.lastInsertRowid],
  );
  const draft = await db.run(
    `INSERT INTO invoice_drafts (store_id, company_id, status, images, invoice_id, created_by)
     VALUES (?,?, 'committed', ?, ?, ?)`,
    [store.id, store.company_id, JSON.stringify(imageRefs), inv.id, ow.id],
  );
  return { productId: prod.lastInsertRowid, draftId: draft.lastInsertRowid };
}

const countOf = async (db, table) => (await db.many(`SELECT 1 FROM ${table}`, [])).length;

// A local-disk stored file (bare filename = a local storage ref, like putBuffer produces when
// no Blob token is configured). Written directly so the test never touches the network.
function tempStoredFile() {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const ref = `test-${crypto.randomUUID()}.jpg`;
  fs.writeFileSync(path.join(config.uploadsDir, ref), Buffer.from([1, 2, 3]));
  return ref;
}

test('exportAll snapshots every table with its rows', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await seedTransactional(db, ow);
  const dump = await exportAll(db);
  assert.equal(dump.meta.app, 'ap-control');
  assert.ok(Array.isArray(dump.tables.invoices) && dump.tables.invoices.length === 1);
  assert.ok(dump.tables.companies.length >= 1);
  assert.ok(dump.tables.users.length >= 1);
  assert.equal(dump.meta.counts.invoices, 1);
});

test('exportAll includes the scan tables (products / prices / lines / drafts)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await seedTransactional(db, ow);
  await seedScanData(db, ow, ['page-1.jpg', 'page-2.jpg']);
  const dump = await exportAll(db);
  for (const t of ['products', 'product_prices', 'invoice_lines', 'invoice_drafts']) {
    assert.ok(Array.isArray(dump.tables[t]), `${t} חסר בגיבוי`);
    assert.equal(dump.meta.counts[t], 1, `${t} לא יוצא לגיבוי`);
  }
  assert.equal(dump.tables.invoice_lines[0].line_total, 1100);
  assert.deepEqual(JSON.parse(dump.tables.invoice_drafts[0].images), ['page-1.jpg', 'page-2.jpg']);
});

test('resetTransactionalData clears transactional data but keeps the setup', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const setupBefore = {
    companies: await countOf(db, 'companies'),
    stores: await countOf(db, 'stores'),
    bank_accounts: await countOf(db, 'bank_accounts'),
    users: await countOf(db, 'users'),
    user_companies: await countOf(db, 'user_companies'),
  };
  await seedTransactional(db, ow);
  assert.equal(await countOf(db, 'invoices'), 1);
  assert.equal(await countOf(db, 'payments'), 1);
  assert.equal(await countOf(db, 'payment_lines'), 1);

  await resetTransactionalData({ alsoSuppliers: false }, ow, db);

  // transactional gone
  assert.equal(await countOf(db, 'invoices'), 0);
  assert.equal(await countOf(db, 'payments'), 0);
  assert.equal(await countOf(db, 'payment_lines'), 0);
  // suppliers kept (alsoSuppliers=false)
  assert.equal(await countOf(db, 'suppliers'), 1);
  // setup preserved exactly
  assert.equal(await countOf(db, 'companies'), setupBefore.companies);
  assert.equal(await countOf(db, 'stores'), setupBefore.stores);
  assert.equal(await countOf(db, 'bank_accounts'), setupBefore.bank_accounts);
  assert.equal(await countOf(db, 'users'), setupBefore.users);
  assert.equal(await countOf(db, 'user_companies'), setupBefore.user_companies);
  // the reset itself is the one fresh audit entry
  assert.equal(await countOf(db, 'audit_log'), 1);
});

test('resetTransactionalData with alsoSuppliers clears the supplier list too', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await seedTransactional(db, ow);
  await resetTransactionalData({ alsoSuppliers: true }, ow, db);
  assert.equal(await countOf(db, 'suppliers'), 0);
  assert.equal(await countOf(db, 'companies') >= 1, true); // setup still there
});

test('resetTransactionalData clears the scan tables and deletes the draft page images', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await seedTransactional(db, ow);
  // real files on disk, referenced by the draft's images JSON array
  const refs = [tempStoredFile(), tempStoredFile()];
  await seedScanData(db, ow, refs);
  // a draft whose images JSON is broken must not break the reset
  const store = await db.one('SELECT id, company_id FROM stores LIMIT 1', []);
  await db.run(
    `INSERT INTO invoice_drafts (store_id, company_id, status, images, created_by)
     VALUES (?,?, 'failed', 'not-json', ?)`,
    [store.id, store.company_id, ow.id],
  );
  const paths = refs.map((r) => path.join(config.uploadsDir, r));
  assert.ok(paths.every((p) => fs.existsSync(p)));

  const { deletedImages } = await resetTransactionalData({ alsoSuppliers: false }, ow, db);

  assert.equal(await countOf(db, 'products'), 0);
  assert.equal(await countOf(db, 'product_prices'), 0);
  assert.equal(await countOf(db, 'invoice_lines'), 0);
  assert.equal(await countOf(db, 'invoice_drafts'), 0);
  // both draft pages were collected and their files removed
  assert.equal(deletedImages, refs.length);
  assert.ok(paths.every((p) => !fs.existsSync(p)));
});

test('restoreAll round-trips a backup (wipe + reinsert everything)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await seedTransactional(db, ow);
  await seedScanData(db, ow);
  const before = {
    invoices: await countOf(db, 'invoices'),
    payments: await countOf(db, 'payments'),
    payment_lines: await countOf(db, 'payment_lines'),
    companies: await countOf(db, 'companies'),
    users: await countOf(db, 'users'),
  };
  const dump = await exportAll(db);

  // wipe EVERYTHING, then restore from the snapshot
  await resetTransactionalData({ alsoSuppliers: true }, ow, db);
  assert.equal(await countOf(db, 'invoices'), 0);

  await restoreAll(dump, ow, db);
  assert.equal(await countOf(db, 'invoices'), before.invoices);
  assert.equal(await countOf(db, 'payments'), before.payments);
  assert.equal(await countOf(db, 'payment_lines'), before.payment_lines);
  assert.equal(await countOf(db, 'suppliers'), 1);
  assert.equal(await countOf(db, 'companies'), before.companies);
  assert.equal(await countOf(db, 'users'), before.users);
  // scan tables come back too (FK-safe order: products after suppliers, lines after invoices)
  assert.equal(await countOf(db, 'products'), 1);
  assert.equal(await countOf(db, 'product_prices'), 1);
  assert.equal(await countOf(db, 'invoice_lines'), 1);
  assert.equal(await countOf(db, 'invoice_drafts'), 1);
});

test('restoreAll rejects a file that is not an AP Control backup', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await assert.rejects(() => restoreAll({ meta: { app: 'other' }, tables: {} }, ow, db), /לא תקין/);
  await assert.rejects(() => restoreAll(null, ow, db), /לא תקין/);
});
