import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
// Disable real Telegram sends during tests (notify() is fire-and-forget).
config.telegram.botToken = null;

import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, getInvoice } from '../src/services/invoices.js';
import { submitRequest, approveRequest, rejectRequest, listRequests, countPending } from '../src/services/changeRequests.js';
import { describeInvoice } from '../src/lib/changeSummary.js';
import { getInvoiceDetail } from '../src/services/invoices.js';
import { toAgorot } from '../src/lib/money.js';

async function setup() {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const ow = await owner(db);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, ow, db);
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'A1', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('1000'), vatAmount: toAgorot('180'), docType: 'tax_invoice' },
    sec, db,
  );
  return { db, sec, ow, invoice };
}

test('submit → approve applies the edit; summary lists the diff', async () => {
  const { db, sec, ow, invoice } = await setup();
  const current = await getInvoiceDetail(invoice.id, db);
  const fields = { supplierId: invoice.supplier_id, storeId: invoice.store_id, invoiceNumber: 'A1', allocationNumber: null, invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('2000'), vatAmount: toAgorot('360'), docType: 'tax_invoice' };
  const summary = describeInvoice(current, fields);
  assert.match(summary, /לפני מע"מ/);

  const rid = await submitRequest({ action: 'invoice.update', entityType: 'invoice', entityId: invoice.id, payload: { id: invoice.id, fields }, summary }, sec, db);
  // not applied yet
  assert.equal((await getInvoice(invoice.id, db)).amount_before_vat, toAgorot('1000'));
  assert.equal(await countPending(db), 1);

  await approveRequest(rid, ow, db);
  assert.equal((await getInvoice(invoice.id, db)).amount_before_vat, toAgorot('2000'));
  assert.equal((await getInvoice(invoice.id, db)).total_amount, toAgorot('2360'));
  assert.equal(await countPending(db), 0);
  const [row] = await listRequests({ status: 'approved' }, db);
  assert.equal(row.status, 'approved');
});

test('reject leaves the entity unchanged', async () => {
  const { db, sec, ow, invoice } = await setup();
  const current = await getInvoiceDetail(invoice.id, db);
  const fields = { supplierId: invoice.supplier_id, storeId: invoice.store_id, invoiceNumber: 'CHANGED', allocationNumber: null, invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('1000'), vatAmount: toAgorot('180'), docType: 'tax_invoice' };
  const rid = await submitRequest({ action: 'invoice.update', entityType: 'invoice', entityId: invoice.id, payload: { id: invoice.id, fields }, summary: describeInvoice(current, fields) }, sec, db);
  await rejectRequest(rid, ow, 'לא מאושר', db);
  assert.equal((await getInvoice(invoice.id, db)).invoice_number, 'A1');
  assert.equal(await countPending(db), 0);
});

test('approve is atomic: a failing apply rolls back and leaves the request pending', async () => {
  const { db, sec, ow, invoice } = await setup();
  // Another invoice already owns allocation 111111111.
  await createInvoice(
    { supplierId: invoice.supplier_id, storeId: invoice.store_id, invoiceNumber: 'OTHER', allocationNumber: '111111111', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('50'), vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  const current = await getInvoiceDetail(invoice.id, db);
  // Request to give our invoice the duplicate allocation — apply() will throw (R2).
  const fields = { supplierId: invoice.supplier_id, storeId: invoice.store_id, invoiceNumber: 'A1', allocationNumber: '111111111', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('1000'), vatAmount: toAgorot('180'), docType: 'tax_invoice' };
  const rid = await submitRequest({ action: 'invoice.update', entityType: 'invoice', entityId: invoice.id, payload: { id: invoice.id, fields }, summary: describeInvoice(current, fields) }, sec, db);

  await assert.rejects(approveRequest(rid, ow, db), /כבר קיים|R2/);
  // request stays pending (not flipped to approved), and the invoice is untouched
  assert.equal((await db.one('SELECT status FROM change_requests WHERE id = ?', [rid])).status, 'pending');
  const inv = await getInvoice(invoice.id, db);
  assert.equal(inv.allocation_number, null);
  assert.equal(await countPending(db), 1);
});

test('cannot approve/reject an already-decided request', async () => {
  const { db, sec, ow, invoice } = await setup();
  const current = await getInvoiceDetail(invoice.id, db);
  const fields = { supplierId: invoice.supplier_id, storeId: invoice.store_id, invoiceNumber: 'A1', allocationNumber: null, invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('1500'), vatAmount: toAgorot('270'), docType: 'tax_invoice' };
  const rid = await submitRequest({ action: 'invoice.update', entityType: 'invoice', entityId: invoice.id, payload: { id: invoice.id, fields }, summary: describeInvoice(current, fields) }, sec, db);
  await approveRequest(rid, ow, db);
  await assert.rejects(approveRequest(rid, ow, db), /כבר טופלה/);
});
