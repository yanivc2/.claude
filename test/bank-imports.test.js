// היסטוריית ייבוא לחשבון בנק, וביטול ייבוא.
//
// המקרה שהוליד את זה: קובץ פעולות של חנות אחת הועלה בטעות לחשבון של חנות אחרת. לפני זה לא היה
// שום סימון של "מאיזו העלאה הגיעה השורה" — ולכן אי אפשר היה לא לראות מה הועלה ולא לבטל אותו,
// והשורות הזרות נשארו מעורבות בתנועות אמיתיות שההתאמה האוטומטית סורקת.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { importTransactions, listImports, deleteImport, getImport } from '../src/services/bankTransactions.js';
import { confirmMatch } from '../src/services/reconciliation.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';

const ROWS = [
  { txnDate: '2026-09-01', amount: -118000, description: 'משיכת צק', rawReference: '1001' },
  { txnDate: '2026-09-02', amount: -48000, description: 'העברה', rawReference: 'TR-77' },
];

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);
  return { db, ow, store, acct };
}

test('an import is recorded as one event, with its file name and counts', async () => {
  const { db, ow, acct } = await world();
  const r = await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'poalim-midnight.xlsx' });
  assert.equal(r.inserted, 2);
  assert.ok(r.importId, 'the batch id comes back, so the caller can point at it');

  const [imp] = await listImports({ accountId: acct.id }, db);
  assert.equal(imp.file_name, 'poalim-midnight.xlsx');
  assert.equal(imp.inserted, 2);
  assert.equal(imp.present, 2);
  assert.equal(imp.matched, 0);
  assert.equal(imp.imported_by_name, ow.name, 'who uploaded it is part of the answer');
});

test('every row carries the import it came from', async () => {
  const { db, ow, acct } = await world();
  const { importId } = await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'a.csv' });
  const rows = await db.many('SELECT import_id FROM bank_transactions', []);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => Number(r.import_id) === Number(importId)));
});

test('a second import is a separate event — deleting one leaves the other alone', async () => {
  const { db, ow, acct } = await world();
  await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'right.csv' });
  const wrong = await importTransactions(
    acct.id, [{ txnDate: '2026-09-05', amount: -9900, description: 'חנות אחרת', rawReference: 'X-1' }],
    'csv', ow, db, { fileName: 'wrong-store.csv' },
  );
  assert.equal((await listImports({ accountId: acct.id }, db)).length, 2);

  const r = await deleteImport(wrong.importId, ow, {}, db);
  assert.equal(r.deleted, 1);
  assert.equal(r.released, 0);
  const left = await listImports({ accountId: acct.id }, db);
  assert.equal(left.length, 1);
  assert.equal(left[0].file_name, 'right.csv');
  assert.equal((await db.many('SELECT id FROM bank_transactions', [])).length, 2, 'only the wrong file went');
});

test('🔴 an import whose rows are already matched is NOT deleted without a second confirmation', async () => {
  const { db, ow, store, acct } = await world();
  const sup = await approveSupplier((await createSupplier({ name: 'טרה' }, ow, db)).id, ow, db);
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-1', invoiceDate: '2026-08-20',
    amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice', allocationNumber: '123456789' }, ow, db);
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number = 'INV-1'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  const pay = await createPayment({ bankAccountId: acct.id, method: 'check', checkNumber: '1001',
    paymentDate: '2026-09-01', invoiceIds: [inv.id] }, ow, db);

  const { importId } = await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'x.csv' });
  const txn = await db.one("SELECT * FROM bank_transactions WHERE raw_reference = '1001'", []);
  await confirmMatch(txn.id, pay.id, ow, db);
  assert.equal((await listImports({ accountId: acct.id }, db))[0].matched, 1);

  await assert.rejects(() => deleteImport(importId, ow, {}, db), /כבר הותאמו/,
    'deleting a matched row would silently detach a check from its bank line');

  // With the explicit confirmation the match is released first, then the rows go.
  const r = await deleteImport(importId, ow, { releaseMatched: true }, db);
  assert.equal(r.released, 1);
  assert.equal(r.deleted, 2);
  assert.equal((await db.many('SELECT id FROM bank_transactions', [])).length, 0);
  const stillThere = await db.one('SELECT id FROM payments WHERE id = ?', [pay.id]);
  assert.ok(stillThere, 'the payment itself is untouched — only the bank match was released');
});

test('deleting an import removes the event too, so the list stays honest', async () => {
  const { db, ow, acct } = await world();
  const { importId } = await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'a.csv' });
  await deleteImport(importId, ow, {}, db);
  assert.equal((await listImports({ accountId: acct.id }, db)).length, 0);
  await assert.rejects(() => getImport(importId, db), /לא נמצא/);
});

test('the list is per account — another store\'s uploads are not shown here', async () => {
  const { db, ow, acct } = await world();
  const other = await db.one('SELECT * FROM bank_accounts WHERE id <> ? LIMIT 1', [acct.id]);
  await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'mine.csv' });
  if (other) {
    await importTransactions(other.id, ROWS, 'csv', ow, db, { fileName: 'theirs.csv' });
    const mine = await listImports({ accountId: acct.id }, db);
    assert.deepEqual(mine.map((i) => i.file_name), ['mine.csv']);
  }
});

test('rows imported before the tracking existed are reported, not hidden', async () => {
  const { db, ow, acct } = await world();
  const { untrackedSummary } = await import('../src/services/bankTransactions.js');
  assert.equal(await untrackedSummary(acct.id, db), null, 'nothing there → nothing to say');

  // a row with no import_id is what every pre-upgrade transaction looks like
  await db.run(`INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, source)
                VALUES (?, '2026-08-01', -5000, 'ישן', 'csv')`, [acct.id]);
  await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'new.csv' });

  const u = await untrackedSummary(acct.id, db);
  assert.equal(u.count, 1, 'only the untracked one');
  assert.equal(u.from, '2026-08-01');
  // The page must not claim "no files imported" while the account is full of transactions.
  assert.ok(u.count > 0);
});

test('bulk delete removes the picked rows, and skips ones matched to a check', async () => {
  const { db, ow, store, acct } = await world();
  const { deleteTransactions } = await import('../src/services/bankTransactions.js');
  const sup = await approveSupplier((await createSupplier({ name: 'טרה' }, ow, db)).id, ow, db);
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-9', invoiceDate: '2026-08-20',
    amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice', allocationNumber: '111222333' }, ow, db);
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number = 'INV-9'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  const pay = await createPayment({ bankAccountId: acct.id, method: 'check', checkNumber: '1001',
    paymentDate: '2026-09-01', invoiceIds: [inv.id] }, ow, db);

  await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'x.csv' });
  const all = await db.many('SELECT id, raw_reference FROM bank_transactions ORDER BY id', []);
  const matchedTxn = all.find((t) => t.raw_reference === '1001');
  await confirmMatch(matchedTxn.id, pay.id, ow, db);

  const r = await deleteTransactions(all.map((t) => t.id), acct.id, ow, {}, db);
  assert.equal(r.deleted, 1, 'the free row went');
  assert.equal(r.skippedMatched, 1, 'the matched one was skipped, not silently detached');
  const left = await db.many('SELECT id FROM bank_transactions', []);
  assert.equal(left.length, 1);
  assert.equal(Number(left[0].id), Number(matchedTxn.id));
});

test('🔒 bulk delete cannot reach another account by a forged id', async () => {
  const { db, ow, acct } = await world();
  const { deleteTransactions } = await import('../src/services/bankTransactions.js');
  const other = await db.one('SELECT * FROM bank_accounts WHERE id <> ? LIMIT 1', [acct.id]);
  if (!other) return;
  await importTransactions(other.id, ROWS, 'csv', ow, db, { fileName: 'theirs.csv' });
  const theirs = await db.many('SELECT id FROM bank_transactions', []);

  const r = await deleteTransactions(theirs.map((t) => t.id), acct.id, ow, {}, db);
  assert.equal(r.deleted, 0, 'ids belonging to another account are simply not there');
  assert.equal((await db.many('SELECT id FROM bank_transactions', [])).length, theirs.length);
});

test('bulk delete refuses an empty selection instead of doing nothing quietly', async () => {
  const { db, ow, acct } = await world();
  const { deleteTransactions } = await import('../src/services/bankTransactions.js');
  await assert.rejects(() => deleteTransactions([], acct.id, ow, {}, db), /לא נבחרו/);
});

test('🔴 before the DB upgrade the page says so — it must not claim "no files imported"', async () => {
  const { importsReady } = await import('../src/services/bankTransactions.js');
  const { db } = await world();
  assert.equal(await importsReady(db), true, 'a fresh schema has it');

  // The tolerant catch that protects a pre-upgrade DB turns "no table" into "no rows". Without a
  // probe the rubric then shows "עדיין לא יובאו קבצים" over an account full of transactions —
  // exactly the display lie the rubric exists to fix. The view branches on this flag.
  const view = (await import('node:fs')).readFileSync(
    (await import('node:path')).join(process.cwd(), 'src/views/reconciliation/index.ejs'), 'utf8',
  );
  assert.match(view, /typeof importsReady !== 'undefined' && !importsReady/);
  assert.match(view, /נדרש עדכון מסד נתונים/);
  assert.ok(view.indexOf('נדרש עדכון מסד נתונים') < view.indexOf('עדיין לא יובאו קבצים לחשבון הזה'),
    'the upgrade notice takes precedence over the empty-state text');
});

test('🔴 cancelling an import also returns its checks to the open list', async () => {
  const { db, ow, store, acct } = await world();
  const sup = await approveSupplier((await createSupplier({ name: 'טרה' }, ow, db)).id, ow, db);
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-11', invoiceDate: '2026-08-20',
    amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice', allocationNumber: '444555666' }, ow, db);
  const inv = await db.one("SELECT * FROM invoices WHERE invoice_number = 'INV-11'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  const pay = await createPayment({ bankAccountId: acct.id, method: 'check', checkNumber: '1001',
    paymentDate: '2026-09-01', invoiceIds: [inv.id] }, ow, db);

  const { importId } = await importTransactions(acct.id, ROWS, 'csv', ow, db, { fileName: 'wrong.csv' });
  const txn = await db.one("SELECT * FROM bank_transactions WHERE raw_reference = '1001'", []);
  await confirmMatch(txn.id, pay.id, ow, db);
  assert.equal((await db.one('SELECT status FROM payments WHERE id = ?', [pay.id])).status, 'cleared');

  await deleteImport(importId, ow, { releaseMatched: true }, db);
  // Clearing only the bank link would leave the check reported as paid for ever — the money never
  // actually moved on this account, so the check has to go back to waiting.
  assert.notEqual((await db.one('SELECT status FROM payments WHERE id = ?', [pay.id])).status, 'cleared');
});
