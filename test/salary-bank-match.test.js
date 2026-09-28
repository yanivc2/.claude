// 🔴 צ׳ק שכר שנפרע בבנק. צ׳קי שכר לא נרשמים כ"תשלום", ולכן ההתאמה האוטומטית (שעובדת רק מול
// payments) לא ראתה אותם: אחרי הסנכרון הראשון 13 צ׳קי שכר הופיעו בלי שום סטטוס, והחיובים שלהם
// נשארו "ממתינים להתאמה". עכשיו: מספר צ׳ק + סכום מדויק → "נפרע בבנק".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { createEmployee } from '../src/services/employees.js';
import { createSalaryPayment, markCashed, listSalaryPayments } from '../src/services/salaryPayments.js';
import { importTransactions, listUnmatched, listTransactions, deleteImport } from '../src/services/bankTransactions.js';
import { reconcileAccount } from '../src/services/reconciliation.js';

async function world() {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id])).id;
  const emp = await createEmployee({ firstName: 'סבטה', lastName: 'לוי' }, o, db);
  const salary = (ref, amount, dueDate = '2026-09-09') =>
    createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: ref, dueDate, amount }, o, db);
  const bank = (rows) => importTransactions(acct, rows, 'scraper', o, db);
  return { db, o, st, acct, salary, bank };
}

test('צ׳ק שכר ↔ חיוב בבנק: מספר צ׳ק + סכום מדויק → "נפרע בבנק", והחיוב כבר לא "ממתין"', async () => {
  const { db, o, acct, salary, bank } = await world();
  const sp = await salary('31993', 1008256);
  const imp = await bank([
    { txnDate: '2026-09-14', amount: -1008256, description: 'שיק', rawReference: '31993', externalId: 'a1' },
    { txnDate: '2026-09-14', amount: -500000, description: 'שיק', rawReference: '31994', externalId: 'a2' }, // מספר אחר
  ]);
  const r = await reconcileAccount(acct, o, db);
  assert.equal(r.salary, 1);
  const row = (await listSalaryPayments({}, db)).find((x) => x.id === sp.id);
  assert.ok(row.bank_txn_id);
  assert.equal(row.bank_date, '2026-09-14');
  const unmatched = (await listUnmatched(acct, db)).map((t) => t.raw_reference);
  assert.deepEqual(unmatched, ['31994'], 'החיוב של צ׳ק השכר יצא מרשימת הממתינים');
  const all = await listTransactions(acct, db);
  assert.equal(all.find((t) => t.raw_reference === '31993').salary_match.name, 'סבטה לוי');

  // ביטול ייבוא הבנק מחזיר את צ׳ק השכר ל"לא נפרע"
  await deleteImport(imp.importId, o, {}, db);
  assert.equal((await db.one('SELECT bank_txn_id FROM salary_payments WHERE id = ?', [sp.id])).bank_txn_id, null);
});

test('סכום שונה, מספר שונה, או פנקס של תקופה אחרת — אין שיוך', async () => {
  const { db, o, acct, salary, bank } = await world();
  await salary('32000', 238360);
  await salary('32001', 100000, '2025-01-01');
  await bank([
    { txnDate: '2026-09-14', amount: -238361, description: 'שיק', rawReference: '32000', externalId: 'b1' }, // אגורה אחת
    { txnDate: '2026-09-14', amount: -238360, description: 'שיק', rawReference: '32999', externalId: 'b2' },
    { txnDate: '2026-09-14', amount: -100000, description: 'שיק', rawReference: '32001', externalId: 'b3' }, // שנה וחצי אחרי
  ]);
  assert.equal((await reconcileAccount(acct, o, db)).salary, 0);
});

test('מספר צ׳ק שנכתב בכתיב מדעי / אפסים מובילים עדיין מותאם', async () => {
  const { db, o, acct, salary, bank } = await world();
  await salary('031995', 683806);
  await bank([{ txnDate: '2026-09-15', amount: -683806, description: 'שיק', rawReference: '3.1995E4', externalId: 'c1' }]);
  assert.equal((await reconcileAccount(acct, o, db)).salary, 1);
});

test('צ׳ק שסומן "נפרט בקופה" ונפרע גם בבנק — משויך ומדווח כתשלום כפול; ולהפך — סימון בקופה נחסם', async () => {
  const { db, o, acct, st, salary, bank } = await world();
  const closing = await db.run(
    `INSERT INTO z_closings (store_id, z_number, employee_first, employee_last, created_by) VALUES (?, '77', 'א', 'ב', ?)`,
    [st.id, o.id],
  );
  const expenseId = (await db.run(
    `INSERT INTO z_closing_expenses (closing_id, expense_date, payer_name, amount) VALUES (?, '2026-09-10', 'סבטה', 424645)`,
    [closing.lastInsertRowid],
  )).lastInsertRowid;
  const sp = await salary('31996', 424645);
  await markCashed(sp.id, expenseId, o, db);
  await bank([{ txnDate: '2026-09-16', amount: -424645, description: 'שיק', rawReference: '31996', externalId: 'd1' }]);
  const r = await reconcileAccount(acct, o, db);
  assert.equal(r.salary, 1);
  assert.equal(r.salaryDoublePaid, 1, 'נפרט בקופה וגם נפרע בבנק = תשלום כפול');
  const sp2 = await salary('31997', 234518);
  await bank([{ txnDate: '2026-09-16', amount: -234518, description: 'שיק', rawReference: '31997', externalId: 'd2' }]);
  await reconcileAccount(acct, o, db);
  await assert.rejects(() => markCashed(sp2.id, expenseId, o, db), /כבר נפרע בבנק/);
});
