// "ניקוי לפי קובץ" — מחיקת השורות שקובץ מסוים הביא לחשבון.
//
// המצב: שלושה קבצים של חנויות אחרות הועלו לחשבון אחד, **לפני** שמעקב הייבוא היה קיים. לשורות אין
// סימון קובץ, הן נראות בדיוק כמו כל תנועה אחרת, ויש 1,157 מהן — אי אפשר לברור ביניהן ביד ואי
// אפשר "לבטל ייבוא" שלא נרשם. מה שכן קיים אצל הבעלים הוא **הקובץ עצמו**, וזה הסימן המדויק.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { importTransactions, matchRowsToTransactions, deleteTransactions } from '../src/services/bankTransactions.js';
import { confirmMatch } from '../src/services/reconciliation.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';

const FOREIGN = [
  { txnDate: '2026-09-01', amount: -118000, description: 'משיכת צק', rawReference: '1001' },
  { txnDate: '2026-09-02', amount: -48000, description: 'העברה לספק', rawReference: 'TR-77' },
  { txnDate: '2026-09-03', amount: -9900, description: 'עמלה', rawReference: null },
];
const MINE = [
  { txnDate: '2026-09-01', amount: -33000, description: 'שלי א', rawReference: 'M-1' },
  { txnDate: '2026-09-04', amount: -71000, description: 'שלי ב', rawReference: 'M-2' },
];

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);
  // exactly the pre-tracking situation: rows with no import_id at all
  for (const r of [...FOREIGN, ...MINE]) {
    await db.run(`INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
                  VALUES (?, ?, ?, ?, ?, 'csv')`, [acct.id, r.txnDate, r.amount, r.description, r.rawReference]);
  }
  return { db, ow, store, acct };
}

test('the file finds exactly the rows it brought, and nothing else', async () => {
  const { db, acct } = await world();
  const hit = await matchRowsToTransactions(acct.id, FOREIGN, db);
  assert.equal(hit.rows.length, 3);
  assert.deepEqual(hit.rows.map((r) => r.description).sort(), ['העברה לספק', 'משיכת צק', 'עמלה']);
  assert.equal(hit.matched.length, 0);
});

test('deleting by the file leaves the account\'s own transactions alone', async () => {
  const { db, ow, acct } = await world();
  const hit = await matchRowsToTransactions(acct.id, FOREIGN, db);
  const r = await deleteTransactions(hit.ids, acct.id, ow, {}, db);
  assert.equal(r.deleted, 3);
  const left = await db.many('SELECT description FROM bank_transactions ORDER BY id', []);
  assert.deepEqual(left.map((x) => x.description), ['שלי א', 'שלי ב']);
});

test('a file uploaded to a DIFFERENT account matches nothing here', async () => {
  const { db, acct } = await world();
  const other = await db.one('SELECT * FROM bank_accounts WHERE id <> ? LIMIT 1', [acct.id]);
  if (!other) return;
  const hit = await matchRowsToTransactions(other.id, FOREIGN, db);
  assert.equal(hit.rows.length, 0, 'the preview must say "nothing found here", not delete someone else\'s rows');
});

test('🔴 a row already matched to a check is reported, never deleted silently', async () => {
  const { db, ow, store, acct } = await world();
  const sup = await approveSupplier((await createSupplier({ name: 'טרה' }, ow, db)).id, ow, db);
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-7', invoiceDate: '2026-08-20',
    amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice', allocationNumber: '123456789' }, ow, db);
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number = 'INV-7'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  const pay = await createPayment({ bankAccountId: acct.id, method: 'check', checkNumber: '1001',
    paymentDate: '2026-09-01', invoiceIds: [inv.id] }, ow, db);
  const txn = await db.one("SELECT * FROM bank_transactions WHERE raw_reference = '1001'", []);
  await confirmMatch(txn.id, pay.id, ow, db);

  const hit = await matchRowsToTransactions(acct.id, FOREIGN, db);
  assert.equal(hit.rows.length, 3, 'still found');
  assert.equal(hit.matched.length, 1, 'but the matched one is separated out');
  assert.equal(hit.ids.length, 2, 'and only the free ones are offered for deletion');
  assert.ok(!hit.ids.includes(Number(txn.id)));
});

test('two identical lines in the file take two transactions, not the same one twice', async () => {
  const { db, acct } = await world();
  const dup = { txnDate: '2026-09-05', amount: -5000, description: 'כפול', rawReference: 'D' };
  for (let i = 0; i < 2; i += 1) {
    await db.run(`INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
                  VALUES (?, ?, ?, ?, ?, 'csv')`, [acct.id, dup.txnDate, dup.amount, dup.description, dup.rawReference]);
  }
  const one = await matchRowsToTransactions(acct.id, [dup], db);
  assert.equal(one.rows.length, 1, 'one line claims one transaction');
  const two = await matchRowsToTransactions(acct.id, [dup, dup], db);
  assert.equal(two.rows.length, 2);
  assert.equal(new Set(two.rows.map((r) => r.id)).size, 2, 'and never the same row twice');
});

test('a tracked import is still deletable as a batch — this is only for the untracked ones', async () => {
  const { db, ow, acct } = await world();
  const { importId } = await importTransactions(acct.id, [
    { txnDate: '2026-10-01', amount: -1000, description: 'חדש', rawReference: 'N-1' },
  ], 'csv', ow, db, { fileName: 'tracked.csv' });
  assert.ok(importId);
  const hit = await matchRowsToTransactions(acct.id, FOREIGN, db);
  assert.ok(!hit.rows.some((r) => r.description === 'חדש'), 'the file only matches what it contains');
});

test('🔴 releasing the false matches: these rows never belonged to this account', async () => {
  const { db, ow, store, acct } = await world();
  const sup = await approveSupplier((await createSupplier({ name: 'טרה' }, ow, db)).id, ow, db);
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-8', invoiceDate: '2026-08-20',
    amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice', allocationNumber: '555666777' }, ow, db);
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number = 'INV-8'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  const pay = await createPayment({ bankAccountId: acct.id, method: 'check', checkNumber: '1001',
    paymentDate: '2026-09-01', invoiceIds: [inv.id] }, ow, db);
  const txn = await db.one("SELECT * FROM bank_transactions WHERE raw_reference = '1001'", []);
  await confirmMatch(txn.id, pay.id, ow, db);

  const hit = await matchRowsToTransactions(acct.id, FOREIGN, db);
  const everything = hit.ids.concat(hit.matched);

  // Without the flag the matched row survives — the default stays cautious.
  const cautious = await deleteTransactions(everything, acct.id, ow, {}, db);
  assert.equal(cautious.skippedMatched, 1);
  assert.equal(cautious.released, 0);
  assert.ok(await db.one('SELECT id FROM bank_transactions WHERE id = ?', [txn.id]));

  // With it, the false match is released and the row goes: the check was never paid by this line.
  const r = await deleteTransactions([txn.id], acct.id, ow, { releaseMatched: true }, db);
  assert.equal(r.released, 1);
  assert.equal(r.deleted, 1);
  assert.equal(r.skippedMatched, 0);
  assert.equal(await db.one('SELECT id FROM bank_transactions WHERE id = ?', [txn.id]), undefined);

  // The check itself is untouched and back among the open ones — it still awaits its real line.
  const stillOpen = await db.one('SELECT id, status FROM payments WHERE id = ?', [pay.id]);
  assert.ok(stillOpen, 'the payment survives — only the bank match was wrong');
  assert.notEqual(stillOpen.status, 'cleared', 'and it is no longer reported as cleared');
});
