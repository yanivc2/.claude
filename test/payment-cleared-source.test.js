import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment, markCleared, listPayments, getPaymentDetail } from '../src/services/payments.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { autoReconcile } from '../src/services/reconciliation.js';
import { toAgorot } from '../src/lib/money.js';

// A cleared check must expose HOW it was cleared so the payments page can colour it:
// auto (matched to a bank transaction) vs. manual ("סמן כנפרע"). The flag is auto_cleared.
async function setup() {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const own = await owner(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, own, db);

  async function issueCheck(num, shekels) {
    const { invoice } = await createInvoice(
      { supplierId: sup.id, storeId: st.id, invoiceNumber: `I${num}`, invoiceDate: '2026-07-20', amountBeforeVat: toAgorot(shekels), vatAmount: toAgorot('0'), docType: 'tax_invoice', confirm: true, confirmReason: 't' },
      sec, db,
    );
    await approveInvoiceForPayment(invoice.id, sec, db);
    return createPayment({ bankAccountId: acct, checkNumber: num, paymentDate: '2026-07-20', invoiceIds: [invoice.id] }, sec, db);
  }
  return { db, sec, acct, issueCheck };
}

test('a check cleared by reconciliation match is flagged auto_cleared', async () => {
  const { db, sec, acct, issueCheck } = await setup();
  const pay = await issueCheck('5001', '1000');
  await importTransactions(acct, [{ txnDate: '2026-07-21', amount: -toAgorot('1000'), description: 'שיק', rawReference: '5001' }], 'csv', sec, db);
  await autoReconcile(acct, sec, db);

  const listed = (await listPayments({ scope: null }, db)).find((p) => p.id === pay.id);
  assert.equal(listed.status, 'cleared');
  assert.ok(listed.auto_cleared, 'listPayments should mark it auto_cleared');
  assert.ok((await getPaymentDetail(pay.id, db)).auto_cleared, 'getPaymentDetail should mark it auto_cleared');
});

test('a check cleared manually ("סמן כנפרע") is NOT flagged auto_cleared', async () => {
  const { db, sec, issueCheck } = await setup();
  const pay = await issueCheck('5002', '2000');
  await markCleared(pay.id, '2026-07-22', sec, db);

  const listed = (await listPayments({ scope: null }, db)).find((p) => p.id === pay.id);
  assert.equal(listed.status, 'cleared');
  assert.ok(!listed.auto_cleared, 'a manual clear must not be auto_cleared');
  assert.ok(!(await getPaymentDetail(pay.id, db)).auto_cleared);
});
