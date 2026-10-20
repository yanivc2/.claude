// בעלים 21/10: צ׳ק 18338 של פינק נכנס בטעות למידנייט, וההתאמה האוטומטית חיברה אותו לצ׳ק 32159 של
// מידנייט — רק כי הסכום (₪1,616) היה זהה. 32159 סומן "נפרע" בלי שנפרע. מעכשיו: מועמד יחיד שמספרו
// סותר את האסמכתה בבנק הוא "מספר שונה — להכרעה", לא התאמה; ובבדיקת שיוך, סעיף 4 מראה את מה שכבר הותאם כך.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { autoReconcile, classify, confirmMatch, checkNumberConflict } from '../src/services/reconciliation.js';
import { accountIntegrity } from '../src/services/accountIntegrity.js';

test('checkNumberConflict: only two different numbers conflict', () => {
  const chk = (n) => ({ method: 'check', check_number: n });
  assert.equal(checkNumberConflict({ raw_reference: '18338' }, chk('32159')), true);
  assert.equal(checkNumberConflict({ raw_reference: '0018338' }, chk('18338')), false, 'leading zeros');
  assert.equal(checkNumberConflict({ raw_reference: '1.8338E4' }, chk('18338')), false, 'scientific notation from a bank file');
  assert.equal(checkNumberConflict({ raw_reference: '18338' }, chk('1018338')), false, 'the bank shortened the number');
  assert.equal(checkNumberConflict({ raw_reference: '' }, chk('32159')), false, 'no reference — amount is all there is');
  assert.equal(checkNumberConflict({ raw_reference: null }, chk('32159')), false);
  assert.equal(checkNumberConflict({ raw_reference: '18338' }, chk(null)), false, 'a check with no number');
  assert.equal(checkNumberConflict({ raw_reference: '18338' }, { method: 'transfer', check_number: null }), false, 'not a check');
});

let db, sec, acct, payment, server, base, o;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  sec = await secretary(db);
  const st = await firstStore(db);
  acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: 'ספק 32159' }, sec, db)).id, o, db);
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'CN-1', invoiceDate: '2026-08-20', amountBeforeVat: 138120, vatAmount: 23480, docType: 'tax_invoice' },
    sec, db,
  );
  await approveInvoiceForPayment(invoice.id, sec, db);
  payment = await createPayment({ bankAccountId: acct, checkNumber: '32159', paymentDate: '2026-08-20', invoiceIds: [invoice.id] }, sec, db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('a single open check of the same amount but another number is not auto-matched', async () => {
  await importTransactions(acct, [{ txnDate: '2026-08-26', amount: -payment.amount, description: 'שיק', rawReference: '18338' }], 'csv', sec, db);
  const res = await autoReconcile(acct, sec, db);
  assert.equal(res.matched, 0);
  assert.equal(res.ambiguous, 1, 'counted as "needs a decision"');
  assert.equal((await db.one('SELECT status FROM payments WHERE id=?', [payment.id])).status, 'issued', 'still outstanding');

  const txn = await db.one("SELECT * FROM bank_transactions WHERE bank_account_id=? AND raw_reference='18338'", [acct]);
  const cls = await classify(txn, db);
  assert.equal(cls.state, 'mismatch');
  assert.equal(cls.suggestion, null);
  assert.equal(cls.candidates.length, 1, 'still offered for a manual decision');

  const html = await (await fetch(`${base}/reconciliation?account=${acct}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /מספר שונה — להכרעה/);
});

test('integrity section 4 lists a match made before the rule — and only that one', async () => {
  const txn = await db.one("SELECT id FROM bank_transactions WHERE bank_account_id=? AND raw_reference='18338'", [acct]);
  await confirmMatch(txn.id, payment.id, o, db); // what the old auto-match did
  const r = await accountIntegrity(acct, db);
  assert.equal(r.mismatchedMatches.length, 1);
  assert.equal(r.mismatchedMatches[0].checkNumber, '32159');
  assert.equal(r.mismatchedMatches[0].txn.raw_reference, '18338');

  const html = await (await fetch(`${base}/reconciliation/integrity?account=${acct}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /סעיף 4 — 1 צ׳קים שהותאמו לפי סכום בלבד/);
  assert.match(html, /4\. צ׳ק שהותאם לפי סכום בלבד/);
  assert.match(html, new RegExp(`<a href="/payments/${payment.id}">32159</a>`));
});
