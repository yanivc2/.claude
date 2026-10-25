// בעלים 25/10: "מדרגה של 5000 ש"ח + מע"מ שממנה צריך מספר הקצאה — אבל אם קיבלתי מהספק 3 פעמים סחורה בשבוע,
// כל חשבונית 3,000 ש"ח, ואני משלם בצ׳ק אחד או בהעברה — אפשר להנפיק תשלום אחד על 9,000 ש"ח ואין צורך במספר
// הקצאה." כלומר R3 נבדק **לכל חשבונית בנפרד**, לפי המע"מ שלה — לעולם לא לפי סכום התשלום שמאגד כמה חשבוניות.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createInvoice } from '../src/services/invoices.js';
import { payInvoices } from '../src/services/payments.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { toAgorot } from '../src/lib/money.js';

test('three ₪3,000 invoices paid by ONE check above the threshold need no allocation number', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const ba = await accountForStore(db, st.id);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק שבועי' }, o, db)).id, o, db);
  const ids = [];
  for (const [n, d] of [['W1', '2026-10-19'], ['W2', '2026-10-21'], ['W3', '2026-10-23']]) {
    const { invoice } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: n, invoiceDate: d,
      amountBeforeVat: toAgorot('3000'), vatAmount: toAgorot('540'), docType: 'tax_invoice',
      confirm: true, confirmReason: 'אספקה שבועית — אותו סכום' }, o, db);
    assert.equal(invoice.status, 'recorded', `${n}: under the threshold on its own — not held`);
    ids.push(invoice.id);
  }
  const { payment } = await payInvoices({ bankAccountId: ba.id, method: 'check', checkNumber: '90001', paymentDate: '2026-10-25', invoiceIds: ids, supplierId: sup.id }, o, db);
  assert.equal(payment.amount, toAgorot('10620'), 'one check for all three (₪9,000 + VAT)');
  const statuses = (await db.many(`SELECT status FROM invoices WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).map((r) => r.status);
  assert.deepEqual(statuses, ['paid', 'paid', 'paid']);
});

test('…but a single invoice over the threshold still needs its own number, even inside a combined payment', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const ba = await accountForStore(db, st.id);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק גדול' }, o, db)).id, o, db);
  const { invoice: small } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'S1', invoiceDate: '2026-10-20',
    amountBeforeVat: toAgorot('3000'), vatAmount: toAgorot('540'), docType: 'tax_invoice' }, o, db);
  const { invoice: big } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'B1', invoiceDate: '2026-10-21',
    amountBeforeVat: toAgorot('6000'), vatAmount: toAgorot('1080'), docType: 'tax_invoice' }, o, db);
  assert.equal(big.status, 'on_hold');
  await assert.rejects(
    () => payInvoices({ bankAccountId: ba.id, method: 'check', checkNumber: '90002', paymentDate: '2026-10-25', invoiceIds: [small.id, big.id], supplierId: sup.id }, o, db),
    /מוחזקת \(R3\)/,
  );
});
