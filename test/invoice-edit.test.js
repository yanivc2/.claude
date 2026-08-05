import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, updateInvoice, getInvoice } from '../src/services/invoices.js';
import { toAgorot } from '../src/lib/money.js';

async function setup() {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, await owner(db), db);
  return { db, st, sec, sup };
}

test('updateInvoice edits amounts, number and type; recomputes total and sign', async () => {
  const { db, st, sec, sup } = await setup();
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'A1', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('1000'), vatAmount: toAgorot('170'), docType: 'tax_invoice' },
    sec, db,
  );

  await updateInvoice(invoice.id, {
    invoiceNumber: 'A1-fixed', amountBeforeVat: toAgorot('2000'), vatAmount: toAgorot('340'), docType: 'tax_invoice',
  }, sec, db);

  const after = await getInvoice(invoice.id, db);
  assert.equal(after.invoice_number, 'A1-fixed');
  assert.equal(after.amount_before_vat, toAgorot('2000'));
  assert.equal(after.total_amount, toAgorot('2340'));

  // switch to credit note -> stored negative
  await updateInvoice(invoice.id, { docType: 'credit_note', amountBeforeVat: toAgorot('2000'), vatAmount: toAgorot('340') }, sec, db);
  const credit = await getInvoice(invoice.id, db);
  assert.equal(credit.total_amount, -toAgorot('2340'));
});

test('updateInvoice rejects a duplicate allocation number and locks paid invoices', async () => {
  const { db, st, sec, sup } = await setup();
  const a = (await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'B1', allocationNumber: '123456789', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice' }, sec, db)).invoice;
  const b = (await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'B2', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('250'), vatAmount: 0, docType: 'tax_invoice' }, sec, db)).invoice;

  await assert.rejects(updateInvoice(b.id, { allocationNumber: '123456789' }, sec, db), /כבר קיים/);

  await db.run("UPDATE invoices SET status = 'paid' WHERE id = ?", [a.id]);
  await assert.rejects(updateInvoice(a.id, { invoiceNumber: 'nope' }, sec, db), /ששולמה/);
});

test('listInvoices filters by invoice number, supplier, store and date range', async () => {
  const { db, st, sec, sup } = await setup();
  const other = await approveSupplier((await createSupplier({ name: 'ספק ב' }, sec, db)).id, await owner(db), db);
  await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'INV-100', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice' }, sec, db);
  await createInvoice({ supplierId: other.id, storeId: st.id, invoiceNumber: 'INV-200', invoiceDate: '2026-08-15', amountBeforeVat: toAgorot('200'), vatAmount: 0, docType: 'tax_invoice' }, sec, db);

  const { listInvoices } = await import('../src/services/invoices.js');
  assert.equal((await listInvoices({ q: '100' }, db)).length, 1);
  assert.equal((await listInvoices({ q: 'INV' }, db)).length, 2);
  assert.equal((await listInvoices({ supplierId: other.id }, db)).length, 1);
  assert.equal((await listInvoices({ from: '2026-08-01', to: '2026-08-31' }, db)).length, 1);
  assert.equal((await listInvoices({ from: '2026-08-01' }, db))[0].invoice_number, 'INV-200');
  // combined: supplier + date that excludes the match → empty
  assert.equal((await listInvoices({ supplierId: sup.id, from: '2026-08-01' }, db)).length, 0);
});
