import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createPayment, updatePayment, getPaymentDetail, voidPayment } from '../src/services/payments.js';
import { toAgorot } from '../src/lib/money.js';

async function payFixture(x) {
  const o = await owner(x);
  const sec = await secretary(x);
  const store = await firstStore(x);
  const ba = await accountForStore(x, store.id);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, x)).id, o, x);
  const inv = (await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-1', invoiceDate: '2026-08-10', amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice' },
    sec, x,
  )).invoice;
  const pay = await createPayment(
    { bankAccountId: ba.id, method: 'check', checkNumber: '9001', paymentDate: '2026-08-12', invoiceIds: [inv.id] },
    o, x,
  );
  return { o, ba, pay };
}

test('updatePayment changes method + identifier + date, keeping amount and links', async () => {
  const x = await freshDb();
  const { o, pay } = await payFixture(x);
  assert.equal(pay.method, 'check');
  const before = pay.amount;

  const upd = await updatePayment(pay.id, { method: 'transfer', reference: 'REF-77', paymentDate: '2026-08-20' }, o, x);
  assert.equal(upd.method, 'transfer');
  assert.equal(upd.reference, 'REF-77');
  assert.equal(upd.check_number, null); // old identifier cleared
  assert.equal(upd.payment_date, '2026-08-20');
  assert.equal(upd.amount, before);      // amount untouched
  assert.equal(upd.lines.length, 1);     // invoice link untouched
});

test('updatePayment enforces the method identifier + check uniqueness, and blocks voided', async () => {
  const x = await freshDb();
  const { o, ba, pay } = await payFixture(x);

  // transfer with no reference → rejected
  await assert.rejects(() => updatePayment(pay.id, { method: 'transfer', reference: '' }, o, x), /אסמכתא/);

  // a second check with the same number in the same account → rejected
  await x.run('INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)', [ba.id, 'check', '9002', '2026-08-12', 5000, o.id]);
  await assert.rejects(() => updatePayment(pay.id, { method: 'check', checkNumber: '9002' }, o, x), /כבר קיים/);

  // voided payments can't be edited
  await voidPayment(pay.id, o, 'טעות', x);
  await assert.rejects(() => updatePayment(pay.id, { method: 'transfer', reference: 'R' }, o, x), /מבוטל/);
});
