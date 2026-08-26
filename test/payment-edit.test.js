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

test('a voided check releases its number — the same number can be re-issued', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const sec = await secretary(x);
  const store = await firstStore(x);
  const ba = await accountForStore(x, store.id);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, x)).id, o, x);
  const mkInv = async (num) => (await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: num, invoiceDate: '2026-08-10', amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice', confirm: true }, sec, x)).invoice;

  const inv1 = await mkInv('A-1');
  const pay1 = await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '7000', paymentDate: '2026-08-12', invoiceIds: [inv1.id] }, o, x);

  // reusing an ACTIVE number is rejected with a friendly message
  const inv2 = await mkInv('A-2');
  await assert.rejects(() => createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '7000', paymentDate: '2026-08-12', invoiceIds: [inv2.id] }, o, x), /כבר קיים/);

  // void the first, then the number is free again
  await voidPayment(pay1.id, o, 'טעות הזנה', x);
  const pay2 = await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '7000', paymentDate: '2026-08-13', invoiceIds: [inv2.id] }, o, x);
  assert.equal(pay2.check_number, '7000');
});

test('updatePayment re-targets a check to add a credit note; net recomputes to the real amount', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const sec = await secretary(x);
  const store = await firstStore(x);
  const ba = await accountForStore(x, store.id);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, x)).id, o, x);
  const inv = (await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-1', invoiceDate: '2026-08-10', amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice', confirm: true }, sec, x)).invoice;
  const credit = (await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'CR-1', invoiceDate: '2026-08-11', amountBeforeVat: toAgorot('30'), vatAmount: 0, docType: 'credit_note', confirm: true }, sec, x)).invoice;

  // Vicki paid a check for the full invoice (₪100) — the credit note wasn't attached yet.
  const pay = await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '8000', paymentDate: '2026-08-12', invoiceIds: [inv.id] }, o, x);
  assert.equal(pay.amount, toAgorot('100'));

  // Add the credit note to the SAME check → net = 100 − 30 = 70, keeping the check number.
  const upd = await updatePayment(pay.id, { method: 'check', checkNumber: '8000', invoiceIds: [inv.id, credit.id] }, o, x);
  assert.equal(upd.amount, toAgorot('70'));
  assert.equal(upd.lines.length, 2);
  assert.equal((await x.one('SELECT status FROM invoices WHERE id=?', [credit.id])).status, 'paid');
  assert.equal((await x.one('SELECT status FROM invoices WHERE id=?', [inv.id])).status, 'paid');
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
