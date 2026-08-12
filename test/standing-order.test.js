import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment, getPaymentDetail } from '../src/services/payments.js';
import { toAgorot } from '../src/lib/money.js';

async function approvedInvoice(db, num) {
  const st = await firstStore(db);
  const sec = await secretary(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: `ספק ${num}` }, sec, db)).id, await owner(db), db);
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: num, invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  await approveInvoiceForPayment(invoice.id, sec, db);
  return { acct, invoiceId: invoice.id, sec };
}

test('standing_order (הו"ק) is a valid payment method and stores its reference', async () => {
  const db = await freshDb();
  const { acct, invoiceId, sec } = await approvedInvoice(db, 'SO-1');
  const p = await createPayment(
    { bankAccountId: acct, method: 'standing_order', reference: 'הרשאה-778', paymentDate: '2026-07-05', invoiceIds: [invoiceId] },
    sec, db,
  );
  const detail = await getPaymentDetail(p.id, db);
  assert.equal(detail.method, 'standing_order');
  assert.equal(detail.reference, 'הרשאה-778');
});

test('standing_order requires a reference/mandate number', async () => {
  const db = await freshDb();
  const { acct, invoiceId, sec } = await approvedInvoice(db, 'SO-2');
  await assert.rejects(
    () => createPayment({ bankAccountId: acct, method: 'standing_order', paymentDate: '2026-07-05', invoiceIds: [invoiceId] }, sec, db),
    /הו"ק|אסמכתא|הרשאה/,
  );
});
