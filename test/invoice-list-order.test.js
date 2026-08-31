// Invoices paid together (one payment) appear one under the other, in saved order, on the list —
// even when other invoices were entered between them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, listInvoices } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';

test('invoices paid on one payment are grouped adjacently in saved order', async () => {
  const db = await freshDb();
  const own = await owner(db);
  const st = await firstStore(db);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, own, db)).id, own, db);
  const mk = async (n, amt) => (await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: n, invoiceDate: '2026-08-01', amountBeforeVat: amt, vatAmount: 0, docType: 'tax_invoice' }, own, db)).invoice;

  const tara = await mk('TARA', 1000);   // saved first
  const mid1 = await mk('MID1', 2000);   // unrelated invoices entered in between
  const mid2 = await mk('MID2', 3000);
  const coke = await mk('COKE', 4000);   // saved later, paid together with TARA

  const ba = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id]);
  await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '9', paymentDate: '2026-08-02', invoiceIds: [tara.id, coke.id] }, own, db);

  const order = (await listInvoices({}, db)).map((i) => i.invoice_number);
  // Group {TARA, COKE} anchored at COKE (newest) sits first, TARA above COKE (saved order);
  // then the in-between invoices, newest first.
  assert.deepEqual(order, ['TARA', 'COKE', 'MID2', 'MID1']);
});
