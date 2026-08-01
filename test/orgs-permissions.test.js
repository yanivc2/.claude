import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import {
  createCompany,
  updateCompany,
  createStoreWithAccount,
  listStructure,
} from '../src/services/orgs.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment, voidPayment } from '../src/services/payments.js';
import { toCsv } from '../src/lib/csvExport.js';
import { toAgorot } from '../src/lib/money.js';

test('org management is owner-only', async () => {
  const db = await freshDb();
  await assert.rejects(createCompany({ name: 'x' }, await secretary(db), db), /בעלים בלבד/);
  const c = await createCompany({ name: 'חברה חדשה', taxId: '123456789' }, await owner(db), db);
  assert.equal(c.tax_id, '123456789');
});

test('createCompany validates a 9-digit tax id', async () => {
  const db = await freshDb();
  const o = await owner(db);
  await assert.rejects(createCompany({ name: 'x', taxId: '12' }, o, db), /9 ספרות/);
  const ok = await createCompany({ name: 'x', taxId: '' }, o, db); // empty allowed
  assert.equal(ok.tax_id, null);
});

test('createStoreWithAccount creates a store and its 1:1 account', async () => {
  const db = await freshDb();
  const company = (await db.one('SELECT id FROM companies LIMIT 1', [])).id;
  const before = (await db.one('SELECT COUNT(*) n FROM bank_accounts', [])).n;
  await createStoreWithAccount(
    { companyId: company, storeName: 'חנות 5', branch: '428', accountNumber: '55555' },
    await owner(db),
    db,
  );
  const after = (await db.one('SELECT COUNT(*) n FROM bank_accounts', [])).n;
  assert.equal(after, before + 1);
  const struct = await listStructure(db);
  const has = struct.some((c) => c.stores.some((s) => s.name === 'חנות 5' && s.account_number === '55555'));
  assert.ok(has);
});

test('updateCompany backfills tax id without touching the name when omitted', async () => {
  const db = await freshDb();
  const c = await db.one('SELECT id, name FROM companies LIMIT 1', []);
  const updated = await updateCompany(c.id, { taxId: '999999999' }, await owner(db), db);
  assert.equal(updated.tax_id, '999999999');
  assert.equal(updated.name, c.name);
});

test('voiding a check is owner-only (permission tightening)', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const o = await owner(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, o, db);
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'V1', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('100'), vatAmount: toAgorot('17'), docType: 'tax_invoice' },
    sec,
    db,
  );
  await approveInvoiceForPayment(invoice.id, sec, db);
  const payment = await createPayment({ bankAccountId: acct, checkNumber: 'V1001', paymentDate: '2026-07-02', invoiceIds: [invoice.id] }, sec, db);

  await assert.rejects(voidPayment(payment.id, sec, null, db), /בעלים בלבד/);
  const voided = await voidPayment(payment.id, o, null, db);
  assert.equal(voided.status, 'voided');
});

test('toCsv quotes commas/quotes/newlines and prepends a BOM', () => {
  const csv = toCsv(['a', 'b'], [['x,y', 'he said "hi"'], ['line1\nline2', 5]]);
  assert.ok(csv.startsWith('﻿'));
  assert.ok(csv.includes('"x,y"'));
  assert.ok(csv.includes('"he said ""hi"""'));
  assert.ok(csv.includes('"line1\nline2"'));
});
