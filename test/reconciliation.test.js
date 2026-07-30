import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { autoReconcile, confirmMatch, unmatch, classify } from '../src/services/reconciliation.js';
import { outstandingChecks } from '../src/services/reports.js';
import { parseCsv } from '../src/lib/csv.js';
import { mapScrapedTransaction } from '../src/scraper/hapoalim.js';
import { toAgorot } from '../src/lib/money.js';

// Build an issued check for `amountShekels` on the first store's account, dated `date`.
function issueCheck(db, { amountShekels, date, checkNumber, invoiceNumber }) {
  const st = firstStore(db);
  const sec = secretary(db);
  const acct = db.prepare('SELECT id FROM bank_accounts WHERE store_id=?').get(st.id).id;
  const sup = approveSupplier(createSupplier({ name: `ספק ${checkNumber}` }, sec, db).id, owner(db), db);
  const before = Math.round(amountShekels / 1.17); // rough split; total is what matters
  const { invoice } = createInvoice(
    {
      supplierId: sup.id,
      storeId: st.id,
      invoiceNumber,
      invoiceDate: date,
      amountBeforeVat: toAgorot(String(before)),
      vatAmount: toAgorot(String(amountShekels - before)),
      docType: 'tax_invoice',
    },
    sec,
    db,
  );
  approveInvoiceForPayment(invoice.id, sec, db);
  const payment = createPayment(
    { bankAccountId: acct, checkNumber, paymentDate: date, invoiceIds: [invoice.id] },
    sec,
    db,
  );
  return { acct, payment };
}

test('CSV parser handles headers, quoted fields and embedded commas', () => {
  const rows = parseCsv('date,amount,description\n2026-07-01,"-1,170.00","check, cleared"\n2026-07-02,500,deposit');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, '-1,170.00');
  assert.equal(rows[0].description, 'check, cleared');
  assert.equal(rows[1].amount, '500');
});

test('mapScrapedTransaction converts to signed agorot and our shape', () => {
  const m = mapScrapedTransaction({
    date: '2026-07-10T00:00:00.000Z',
    chargedAmount: -1170.5,
    description: 'צ׳ק',
    identifier: 5001,
    status: 'completed',
  });
  assert.deepEqual(m, {
    txnDate: '2026-07-10',
    amount: -117050,
    description: 'צ׳ק',
    rawReference: '5001',
    status: 'completed',
  });
});

test('auto-reconcile matches a single candidate by amount + date window and clears it', () => {
  const db = freshDb();
  const { acct, payment } = issueCheck(db, { amountShekels: 1170, date: '2026-07-01', checkNumber: '1001', invoiceNumber: 'A' });

  // outstanding before
  assert.equal(outstandingChecks(db).totalOutstanding, payment.amount);

  importTransactions(acct, [{ txnDate: '2026-07-05', amount: -payment.amount, description: 'משיכת צ׳ק' }], 'manual', secretary(db), db);
  const res = autoReconcile(acct, secretary(db), db);
  assert.deepEqual(res, { matched: 1, ambiguous: 0, unmatched: 0 });

  const p = db.prepare('SELECT status, cleared_date FROM payments WHERE id=?').get(payment.id);
  assert.equal(p.status, 'cleared');
  assert.equal(p.cleared_date, '2026-07-05');
  assert.equal(outstandingChecks(db).totalOutstanding, 0); // no longer outstanding
});

test('two open checks of the same amount in the window are ambiguous, not auto-matched', () => {
  const db = freshDb();
  const { acct } = issueCheck(db, { amountShekels: 500, date: '2026-07-01', checkNumber: '2001', invoiceNumber: 'B1' });
  issueCheck(db, { amountShekels: 500, date: '2026-07-02', checkNumber: '2002', invoiceNumber: 'B2' });

  importTransactions(acct, [{ txnDate: '2026-07-06', amount: -50000, description: 'צ׳ק' }], 'manual', secretary(db), db);
  const res = autoReconcile(acct, secretary(db), db);
  assert.equal(res.matched, 0);
  assert.equal(res.ambiguous, 1);

  // The secretary decides manually.
  const txn = db.prepare('SELECT * FROM bank_transactions WHERE bank_account_id=?').get(acct);
  const cls = classify(txn, db);
  assert.equal(cls.state, 'ambiguous');
  assert.equal(cls.candidates.length, 2);
  confirmMatch(txn.id, cls.candidates[0].id, secretary(db), db);
  assert.equal(db.prepare('SELECT status FROM payments WHERE id=?').get(cls.candidates[0].id).status, 'cleared');
});

test('deterministic: check number present in the transaction text wins among candidates', () => {
  const db = freshDb();
  const { acct } = issueCheck(db, { amountShekels: 800, date: '2026-07-01', checkNumber: '3001', invoiceNumber: 'C1' });
  const second = issueCheck(db, { amountShekels: 800, date: '2026-07-02', checkNumber: '3002', invoiceNumber: 'C2' });

  importTransactions(acct, [{ txnDate: '2026-07-07', amount: -80000, description: 'פירעon צ׳ק 3002' }], 'manual', secretary(db), db);
  const res = autoReconcile(acct, secretary(db), db);
  assert.equal(res.matched, 1); // deterministic despite two same-amount candidates
  assert.equal(db.prepare('SELECT status FROM payments WHERE id=?').get(second.payment.id).status, 'cleared');
});

test('credits and amount mismatches never match; unmatch reverts a cleared check', () => {
  const db = freshDb();
  const { acct, payment } = issueCheck(db, { amountShekels: 1170, date: '2026-07-01', checkNumber: '4001', invoiceNumber: 'D' });

  // a credit (positive) and a wrong amount debit
  importTransactions(
    acct,
    [
      { txnDate: '2026-07-05', amount: 117000, description: 'הפקדה' },
      { txnDate: '2026-07-05', amount: -99999, description: 'סכום אחר' },
    ],
    'manual',
    secretary(db),
    db,
  );
  const res = autoReconcile(acct, secretary(db), db);
  assert.equal(res.matched, 0);

  // now the correct debit, match, then unmatch
  importTransactions(acct, [{ txnDate: '2026-07-06', amount: -payment.amount, description: 'צ׳ק' }], 'manual', secretary(db), db);
  autoReconcile(acct, secretary(db), db);
  assert.equal(db.prepare('SELECT status FROM payments WHERE id=?').get(payment.id).status, 'cleared');

  const matchedTxn = db.prepare('SELECT * FROM bank_transactions WHERE matched_payment_id=?').get(payment.id);
  unmatch(matchedTxn.id, secretary(db), db);
  const p = db.prepare('SELECT status, cleared_date FROM payments WHERE id=?').get(payment.id);
  assert.equal(p.status, 'issued');
  assert.equal(p.cleared_date, null);
});

test('importTransactions is idempotent on identical rows', () => {
  const db = freshDb();
  const acct = db.prepare('SELECT id FROM bank_accounts LIMIT 1').get().id;
  const row = { txnDate: '2026-07-01', amount: -12345, description: 'x', rawReference: 'r1' };
  assert.deepEqual(importTransactions(acct, [row], 'manual', null, db), { inserted: 1, skipped: 0 });
  assert.deepEqual(importTransactions(acct, [row], 'manual', null, db), { inserted: 0, skipped: 1 });
});
