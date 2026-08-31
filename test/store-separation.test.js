// Store-level authorization (הפרדת חנות): a non-owner granted only specific stores must not
// reach a SIBLING store's records within the same company. Exercises the by-id guard
// (assertInScope with the full req.scope shape) end-to-end with two stores in one company.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment, listInvoices, listPayable } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZReport } from '../src/services/zreports.js';
import { assertInScope } from '../src/lib/scopeGuard.js';
import { authorizedCompanyIds, authorizedStoreIds, setUserStores } from '../src/lib/scope.js';
import { NotFoundError } from '../src/lib/errors.js';

// Build the { companyIds, storeIds } shape currentUser puts on req.scope.
async function scopeOf(user, db) {
  return { companyIds: await authorizedCompanyIds(user, db), storeIds: await authorizedStoreIds(user, db) };
}

async function twoStoresOneCompany() {
  const db = await freshDb();
  const own = await owner(db);
  const sec = await secretary(db);
  const storeA = await firstStore(db); // seeded store
  const companyId = (await db.one('SELECT company_id FROM stores WHERE id = ?', [storeA.id])).company_id;
  // A second store in the SAME company, with its own bank account.
  const bId = (await db.run('INSERT INTO stores (company_id, name) VALUES (?, ?)', [companyId, 'חנות ב'])).lastInsertRowid;
  await db.run(
    `INSERT INTO bank_accounts (company_id, store_id, bank_name, branch, account_number, display_name)
     VALUES (?, ?, 'הפועלים', '428', '999', 'חנות ב · חשבון')`,
    [companyId, bId],
  );
  const storeB = { id: bId };
  const acctA = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [storeA.id]);
  const acctB = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [storeB.id]);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, own, db)).id, own, db);
  return { db, own, sec, storeA, storeB, companyId, acctA, acctB, sup };
}

test('a store-A-only secretary is refused a sibling store-B invoice by id, but reaches store A', async () => {
  const { db, own, sec, storeA, storeB, sup } = await twoStoresOneCompany();
  const invA = (await createInvoice({ supplierId: sup.id, storeId: storeA.id, invoiceNumber: 'A1', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' }, own, db)).invoice;
  const invB = (await createInvoice({ supplierId: sup.id, storeId: storeB.id, invoiceNumber: 'B1', invoiceDate: '2026-07-01', amountBeforeVat: 20000, vatAmount: 0, docType: 'tax_invoice' }, own, db)).invoice;

  await setUserStores(sec.id, [storeA.id], db);
  const scope = await scopeOf(sec, db);
  assert.deepEqual(scope.storeIds, [storeA.id]); // explicit grant → exactly store A

  // Store A invoice: allowed (returns its company_id).
  assert.ok(await assertInScope('invoice', invA.id, scope, db));
  // Store B invoice: same company, different store → refused.
  await assert.rejects(assertInScope('invoice', invB.id, scope, db), NotFoundError);
});

test('store guard covers payment, zreport and bankAccount kinds for a store-scoped user', async () => {
  const { db, own, sec, storeA, storeB, acctA, acctB, sup } = await twoStoresOneCompany();
  // A paid invoice + payment in each store.
  const invA = (await createInvoice({ supplierId: sup.id, storeId: storeA.id, invoiceNumber: 'A2', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' }, own, db)).invoice;
  const invB = (await createInvoice({ supplierId: sup.id, storeId: storeB.id, invoiceNumber: 'B2', invoiceDate: '2026-07-01', amountBeforeVat: 20000, vatAmount: 0, docType: 'tax_invoice' }, own, db)).invoice;
  await approveInvoiceForPayment(invA.id, own, db);
  await approveInvoiceForPayment(invB.id, own, db);
  const payA = await createPayment({ bankAccountId: acctA.id, method: 'check', checkNumber: '5001', paymentDate: '2026-07-02', invoiceIds: [invA.id] }, own, db);
  const payB = await createPayment({ bankAccountId: acctB.id, method: 'check', checkNumber: '5002', paymentDate: '2026-07-02', invoiceIds: [invB.id] }, own, db);
  const zA = await createZReport({ storeId: storeA.id, zNumber: '701', zDate: '2026-07-03', dailyTotal: 100000, drawerCash: 100000 }, own, db);
  const zB = await createZReport({ storeId: storeB.id, zNumber: '702', zDate: '2026-07-03', dailyTotal: 100000, drawerCash: 100000 }, own, db);

  await setUserStores(sec.id, [storeA.id], db);
  const scope = await scopeOf(sec, db);

  // Store A side: all allowed.
  assert.ok(await assertInScope('payment', payA.id, scope, db));
  assert.ok(await assertInScope('zreport', zA.id, scope, db));
  assert.ok(await assertInScope('bankAccount', acctA.id, scope, db));
  // Store B side: all refused for a store-A-only user (same company).
  await assert.rejects(assertInScope('payment', payB.id, scope, db), NotFoundError);
  await assert.rejects(assertInScope('zreport', zB.id, scope, db), NotFoundError);
  await assert.rejects(assertInScope('bankAccount', acctB.id, scope, db), NotFoundError);
});

test('list views filter by store: a store-A-only user sees no store-B rows (both dialects)', async () => {
  const { db, own, sec, storeA, storeB, sup } = await twoStoresOneCompany();
  const invA = (await createInvoice({ supplierId: sup.id, storeId: storeA.id, invoiceNumber: 'LA', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' }, own, db)).invoice;
  const invB = (await createInvoice({ supplierId: sup.id, storeId: storeB.id, invoiceNumber: 'LB', invoiceDate: '2026-07-01', amountBeforeVat: 20000, vatAmount: 0, docType: 'tax_invoice' }, own, db)).invoice;

  await setUserStores(sec.id, [storeA.id], db);
  const scope = await scopeOf(sec, db);

  const invoices = await listInvoices({ scope }, db);
  const ids = invoices.map((i) => i.id);
  assert.ok(ids.includes(invA.id), 'store A invoice present');
  assert.ok(!ids.includes(invB.id), 'store B invoice filtered out');

  const payable = await listPayable(scope, db);
  const pids = payable.map((i) => i.id);
  assert.ok(pids.includes(invA.id) && !pids.includes(invB.id));

  // Owner (null scope) still sees both.
  const ownerInvoices = await listInvoices({ scope: null }, db);
  const oids = ownerInvoices.map((i) => i.id);
  assert.ok(oids.includes(invA.id) && oids.includes(invB.id));
});

test('a company-only grant (no explicit stores) still sees every store in the company', async () => {
  const { db, own, sec, storeA, storeB, sup } = await twoStoresOneCompany();
  const invB = (await createInvoice({ supplierId: sup.id, storeId: storeB.id, invoiceNumber: 'B3', invoiceDate: '2026-07-01', amountBeforeVat: 20000, vatAmount: 0, docType: 'tax_invoice' }, own, db)).invoice;
  // Grant the whole company, no per-store rows → storeIds = all stores in the company.
  const companyId = (await db.one('SELECT company_id FROM stores WHERE id = ?', [storeA.id])).company_id;
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [sec.id, companyId]);
  const scope = await scopeOf(sec, db);
  assert.ok(scope.storeIds.includes(storeA.id) && scope.storeIds.includes(storeB.id));
  // Sibling store B invoice is reachable — company-only grant is not tightened.
  assert.ok(await assertInScope('invoice', invB.id, scope, db));
});
