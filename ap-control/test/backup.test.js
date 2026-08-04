import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
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

const countOf = async (db, table) => (await db.many(`SELECT 1 FROM ${table}`, [])).length;

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

test('restoreAll round-trips a backup (wipe + reinsert everything)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await seedTransactional(db, ow);
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
});

test('restoreAll rejects a file that is not an AP Control backup', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await assert.rejects(() => restoreAll({ meta: { app: 'other' }, tables: {} }, ow, db), /לא תקין/);
  await assert.rejects(() => restoreAll(null, ow, db), /לא תקין/);
});
