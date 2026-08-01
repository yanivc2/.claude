import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { parseCsv } from '../src/lib/csv.js';
import { normalizeBankRows } from '../src/lib/bankCsv.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { autoReconcile } from '../src/services/reconciliation.js';
import { toAgorot } from '../src/lib/money.js';

const BANK_CSV = [
  'תאריך,תיאור הפעולה,פרטים,חשבון,אסמכתא,תאריך ערך,חובה,זכות,יתרה לאחר פעולה,',
  '2026-07-26, שיק , ,12 628 432110,31505,2026-07-26,1911.66,,-67905.82,',
  '2026-07-26, אמריקן אקספרס ,  עבור: יניב רום,12 628 432110,26000281,2026-07-26,,46.16,-65994.16,',
  '2026-07-28, העברה לאחר ,לטובת: רונקין,12 628 432110,473018585,2026-07-28,1888.00,,71385.26,',
].join('\n');

test('normalizeBankRows parses the real Bank Hapoalim export (חובה/זכות, אסמכתא=check no.)', () => {
  const rows = normalizeBankRows(parseCsv(BANK_CSV));
  assert.equal(rows.length, 3);
  // check debit -> negative, reference is the check number
  assert.equal(rows[0].amount, -toAgorot('1911.66'));
  assert.equal(rows[0].rawReference, '31505');
  assert.equal(rows[0].txnDate, '2026-07-26');
  assert.equal(rows[0].description, 'שיק');
  // credit -> positive
  assert.equal(rows[1].amount, toAgorot('46.16'));
  // transfer debit -> negative
  assert.equal(rows[2].amount, -toAgorot('1888.00'));
});

test('unescaped quotes inside a field (בע"מ / מע"מ) do not shift columns', () => {
  const csv = [
    'תאריך,תיאור הפעולה,פרטים,חשבון,אסמכתא,תאריך ערך,חובה,זכות,יתרה לאחר פעולה,',
    '2026-07-28, העברה לאחר ,לטובת: רונקין טכנולוגיות בע"מ עבור: נגישות,12 628 432110,473018585,2026-07-28,1888.00,,71385.26,',
  ].join('\n');
  const rows = normalizeBankRows(parseCsv(csv));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -toAgorot('1888.00')); // amount column NOT shifted by the stray quote
  assert.equal(rows[0].txnDate, '2026-07-28');
  assert.equal(rows[0].rawReference, '473018585');
  assert.ok(rows[0].description.includes('בע"מ'));
});

test('simple CSV format still works and reports a bad row', () => {
  const ok = normalizeBankRows(parseCsv('date,amount,description,reference\n2026-07-01,-100.50,x,7'));
  assert.equal(ok[0].amount, -10050);
  assert.equal(ok[0].rawReference, '7');
  assert.throws(() => normalizeBankRows(parseCsv('date,amount\n,,')), /שורה 2/);
});

test('deterministic match by check number wins even against a same-amount ambiguity', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sec = secretary(db);
  const acct = db.prepare('SELECT id FROM bank_accounts WHERE store_id=?').get(st.id).id;
  const sup = approveSupplier(createSupplier({ name: 'ספק' }, sec, db).id, owner(db), db);

  // two checks, same amount + close dates -> would be ambiguous by amount alone
  function issue(num) {
    const { invoice } = createInvoice(
      { supplierId: sup.id, storeId: st.id, invoiceNumber: `I${num}`, invoiceDate: '2026-07-20', amountBeforeVat: toAgorot('1620'), vatAmount: toAgorot('291.66'), docType: 'tax_invoice', confirm: true, confirmReason: 'test setup' },
      sec,
      db,
    );
    approveInvoiceForPayment(invoice.id, sec, db);
    return createPayment({ bankAccountId: acct, checkNumber: num, paymentDate: '2026-07-20', invoiceIds: [invoice.id] }, sec, db);
  }
  issue('31505');
  const other = issue('31530');

  // import the real debit for check 31505 (amount 1911.66, reference = check number)
  const rows = normalizeBankRows(parseCsv(BANK_CSV)).filter((r) => r.rawReference === '31505');
  importTransactions(acct, rows, 'csv', sec, db);

  const res = autoReconcile(acct, sec, db);
  assert.equal(res.matched, 1); // deterministic despite the same-amount sibling
  const cleared = db.prepare("SELECT check_number FROM payments WHERE status='cleared'").all().map((r) => r.check_number);
  assert.deepEqual(cleared, ['31505']);
  assert.equal(db.prepare('SELECT status FROM payments WHERE id=?').get(other.id).status, 'issued');
});
