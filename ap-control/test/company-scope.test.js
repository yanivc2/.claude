import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { authorizedCompanyIds, setUserCompanies, getUserCompanyIds } from '../src/lib/scope.js';
import { listInvoices } from '../src/services/invoices.js';
import { dashboardStats } from '../src/services/reports.js';

// Per-user company separation (הפרדת חברות): a non-owner sees only their granted companies;
// the owner sees everything. Seeded team: ויקי=all, אדם=על הדרך, רון=פינק מרקט.

async function companyIdByName(db, name) {
  const c = await db.one('SELECT id FROM companies WHERE name = ?', [name]);
  return c.id;
}

async function makeInvoice(db, { companyId, storeId, supplierId, userId, number }) {
  await db.run(
    `INSERT INTO invoices (supplier_id, company_id, store_id, invoice_number, invoice_date,
       amount_before_vat, vat_amount, total_amount, doc_type, status, created_by)
     VALUES (?, ?, ?, ?, '2026-07-01', 1000, 180, 1180, 'tax_invoice', 'recorded', ?)`,
    [supplierId, companyId, storeId, number, userId],
  );
}

test('seeded team has the right company grants; owner = all', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  assert.equal(await authorizedCompanyIds(ow, db), null); // owner sees all

  const adam = await db.one("SELECT * FROM users WHERE username = 'adam'", []);
  const ron = await db.one("SELECT * FROM users WHERE username = 'ron'", []);
  const vicky = await db.one("SELECT * FROM users WHERE username = 'vicky'", []);

  const alHaderech = await companyIdByName(db, 'על הדרך 24 שעות בע"מ');
  const pink = await companyIdByName(db, 'פינק מרקט י.ר. בע"מ');

  assert.deepEqual(await authorizedCompanyIds(adam, db), [alHaderech]);
  assert.deepEqual(await authorizedCompanyIds(ron, db), [pink]);
  assert.equal((await authorizedCompanyIds(vicky, db)).length, 3);

  // new members have no password yet (set via WhatsApp invite)
  assert.equal(adam.password_hash, null);
});

test('listInvoices + dashboardStats are scoped per user', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const adam = await db.one("SELECT * FROM users WHERE username = 'adam'", []);

  const supRes = await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק', 'approved')", []);
  const supplierId = supRes.lastInsertRowid;

  const alHaderech = await companyIdByName(db, 'על הדרך 24 שעות בע"מ');
  const yaniv = await companyIdByName(db, 'יניב רום יזמות בע"מ');
  const alStore = await db.one('SELECT id FROM stores WHERE company_id = ? LIMIT 1', [alHaderech]);
  const yStore = await db.one('SELECT id FROM stores WHERE company_id = ? LIMIT 1', [yaniv]);

  await makeInvoice(db, { companyId: alHaderech, storeId: alStore.id, supplierId, userId: ow.id, number: 'AL-1' });
  await makeInvoice(db, { companyId: yaniv, storeId: yStore.id, supplierId, userId: ow.id, number: 'YR-1' });

  const ownerAll = await listInvoices({ scope: null }, db);
  assert.equal(ownerAll.length, 2); // owner sees both companies

  const adamScope = await authorizedCompanyIds(adam, db);
  const adamInv = await listInvoices({ scope: adamScope }, db);
  assert.equal(adamInv.length, 1);
  assert.equal(adamInv[0].invoice_number, 'AL-1'); // only על הדרך

  const stats = await dashboardStats(null, db);
  assert.equal(Number(stats.pendingSuppliers), 0);
});

test('setUserCompanies replaces grants', async () => {
  const db = await freshDb();
  const adam = await db.one("SELECT * FROM users WHERE username = 'adam'", []);
  const yaniv = await companyIdByName(db, 'יניב רום יזמות בע"מ');
  await setUserCompanies(adam.id, [yaniv], db);
  assert.deepEqual(await getUserCompanyIds(adam.id, db), [yaniv]);
});
