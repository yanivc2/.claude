// Voiding rules + the "voided check appeared in the bank" alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment, voidPayment, markCleared } from '../src/services/payments.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { confirmMatch, autoReconcile, voidedChecksSeenInBank } from '../src/services/reconciliation.js';

async function payFor(amountAgorot, checkNo) {
  const db = await freshDb();
  const own = await owner(db);
  const st = await firstStore(db);
  const ba = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id]);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, own, db)).id, own, db);
  const { invoice } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'N' + checkNo, invoiceDate: '2026-07-01', amountBeforeVat: amountAgorot, vatAmount: 0, docType: 'tax_invoice' }, own, db);
  await approveInvoiceForPayment(invoice.id, own, db);
  const pay = await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: checkNo, paymentDate: '2026-07-02', invoiceIds: [invoice.id] }, own, db);
  return { db, own, st, ba, pay };
}

test('a cleared payment cannot be voided (money already went through)', async () => {
  const { db, own, pay } = await payFor(10000, '6001');
  await markCleared(pay.id, '2026-07-05', own, db);
  await assert.rejects(voidPayment(pay.id, own, null, db), /נפרע/);
});

test('a bank-matched payment cannot be voided until unmatched', async () => {
  const { db, own, ba, pay } = await payFor(10000, '6002');
  await importTransactions(ba.id, [{ txnDate: '2026-07-03', amount: -10000, description: 'x', rawReference: '6002' }], 'manual', own, db);
  const txn = await db.one('SELECT id FROM bank_transactions WHERE bank_account_id = ?', [ba.id]);
  await confirmMatch(txn.id, pay.id, own, db);
  await assert.rejects(voidPayment(pay.id, own, null, db), /הותאם לתנועת בנק/);
});

test('an issued, unmatched payment can still be voided', async () => {
  const { db, own, pay } = await payFor(10000, '6003');
  const res = await voidPayment(pay.id, own, 'טעות', db);
  assert.equal(res.status, 'voided');
});

test('a voided check that shows up in the bank is flagged (dashboard) and alerts', async () => {
  const { db, own, ba, pay } = await payFor(10000, '6004');
  await voidPayment(pay.id, own, 'בוטל בטעות', db); // voided while issued (allowed)
  // ...but the check actually cleared the bank: a matching debit lands with its number in the text.
  await importTransactions(ba.id, [{ txnDate: '2026-07-10', amount: -10000, description: 'צ׳ק 6004', rawReference: '6004' }], 'manual', own, db);

  const flag = await voidedChecksSeenInBank(null, null, db);
  assert.equal(flag.count, 1);
  assert.equal(flag.rows[0].payment.check_number, '6004');

  // Auto-reconcile does NOT match it to the voided check, and reports it as seen.
  const r = await autoReconcile(ba.id, own, db);
  assert.equal(r.matched, 0);
  assert.equal(r.voidedSeen, 1);
});
