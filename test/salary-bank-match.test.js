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

test('צ׳ק שהוזן אחרי ששורת הבנק שלו כבר נמשכה — מותאם בסנכרון הבא, גם כשאין בו תנועות חדשות', async () => {
  const { importScrapedBatch } = await import('../src/services/bankSync.js');
  const { db, o, acct, salary } = await world();
  const ba = await db.one('SELECT account_number FROM bank_accounts WHERE id = ?', [acct]);
  const payload = { accounts: [{ accountNumber: ba.account_number, transactions: [
    { txnDate: '2026-09-14', amount: -754321, description: 'שיק', rawReference: '32210', externalId: 'e1' },
  ] }] };
  await importScrapedBatch(payload, o, db);
  const sp = await salary('32210', 754321); // הוזן אחרי המשיכה
  const again = await importScrapedBatch(payload, o, db); // אותן שורות — 0 חדשות
  assert.equal(again.inserted, 0);
  assert.ok((await db.one('SELECT bank_txn_id FROM salary_payments WHERE id = ?', [sp.id])).bank_txn_id, 'הותאם בכל זאת');
});

test('שכר של חנות אחת שיצא מהחשבון של חנות אחרת באותה חברה — מותאם; מחברה אחרת — לא', async () => {
  const { db, o, st, salary } = await world();
  const company = (await db.one('SELECT company_id FROM stores WHERE id = ?', [st.id])).company_id;
  const sib = (await db.run('INSERT INTO stores (company_id, name) VALUES (?, ?)', [company, 'חנות אחות'])).lastInsertRowid;
  const sibAcct = (await db.run(
    `INSERT INTO bank_accounts (company_id, store_id, bank_name, branch, account_number, display_name) VALUES (?, ?, 'הפועלים', '628', '999111', 'אחות')`,
    [company, sib],
  )).lastInsertRowid;
  const other = await db.one('SELECT ba.id AS acct FROM bank_accounts ba WHERE ba.company_id <> ?', [company]);

  await salary('27750', 1291992);
  await salary('27751', 115600);
  await importTransactions(sibAcct, [{ txnDate: '2026-09-12', amount: -1291992, description: 'שיק', rawReference: '27750', externalId: 'f1' }], 'scraper', o, db);
  assert.equal((await reconcileAccount(sibAcct, o, db)).salary, 1, 'חשבון של חנות אחות באותה חברה');
  await importTransactions(other.acct, [{ txnDate: '2026-09-12', amount: -115600, description: 'שיק', rawReference: '27751', externalId: 'f2' }], 'scraper', o, db);
  assert.equal((await reconcileAccount(other.acct, o, db)).salary, 0, 'חברה אחרת = ספר כסף אחר');
});

test('הסבר בשורה: טרם נפרע / סכום שונה / נמצא — ממתין להתאמה', async () => {
  const { attachSalaryBankHints } = await import('../src/services/salaryPayments.js');
  const { db, salary, bank } = await world();
  await salary('27740', 406114);
  await salary('27741', 362098);
  await salary('27742', 141952);
  await bank([
    { txnDate: '2026-09-12', amount: -362000, description: 'שיק', rawReference: '27741', externalId: 'g1' },
    { txnDate: '2026-09-12', amount: -141952, description: 'שיק', rawReference: '27742', externalId: 'g2' },
  ]);
  const rows = await attachSalaryBankHints(await listSalaryPayments({}, db), db);
  const hint = (ref) => rows.find((r) => r.reference === ref).bank_hint;
  assert.match(hint('27740'), /טרם נפרע/);
  assert.match(hint('27741'), /3,620\.00|3620\.00/);
  assert.match(hint('27741'), /שונה מהסכום/);
  assert.match(hint('27742'), /התאמה אוטומטית/);
});

// 🔴 נצפה: העברות שכר עם אסמכתה נשארו בלי התאמה — רק צ׳קים נבדקו.
test('העברת שכר ↔ חיוב בבנק לפי אסמכתה + סכום; מקבץ של כמה עובדים ↔ חיוב אחד בסכום הכולל', async () => {
  const { db, o, st, acct, bank } = await world();
  const emp2 = await createEmployee({ firstName: 'זאב', lastName: 'כהן' }, o, db);
  const emp3 = await createEmployee({ firstName: 'שלי', lastName: 'פורמן' }, o, db);
  const pay = (employeeId, method, reference, amount) =>
    createSalaryPayment({ storeId: st.id, employeeId, method, reference, dueDate: '2026-09-08', amount }, o, db);
  const single = await pay(emp2.id, 'transfer', '10208394', 1309289);
  const b1 = await pay(emp2.id, 'batch', '777001', 200000);
  const b2 = await pay(emp3.id, 'batch', '777001', 288000);
  await bank([
    { txnDate: '2026-09-08', amount: -1309289, description: 'העב׳ במקבץ-נט', rawReference: '10208394', externalId: 'h1' },
    { txnDate: '2026-09-08', amount: -488000, description: 'העב׳ במקבץ-נט', rawReference: '777001', externalId: 'h2' },
  ]);
  const r = await reconcileAccount(acct, o, db);
  assert.equal(r.salary, 3);
  const linkOf = async (id) => (await db.one('SELECT bank_txn_id FROM salary_payments WHERE id = ?', [id])).bank_txn_id;
  assert.ok(await linkOf(single.id));
  assert.equal(await linkOf(b1.id), await linkOf(b2.id), 'שתי שורות המקבץ על אותו חיוב');

  // והחיובים האלה אינם "העברה ללא תיעוד" בלוח הבקרה
  const { setWatchFrom, untrackedTransfers } = await import('../src/services/transfers.js');
  await setWatchFrom('2026-01-01', o, db);
  assert.deepEqual(await untrackedTransfers({ scope: null }, db), []);
});

test('העברת שכר עם אסמכתה שלא מופיעה בבנק — ההסבר מציע חיוב פנוי באותו סכום', async () => {
  const { attachSalaryBankHints } = await import('../src/services/salaryPayments.js');
  const { db, o, st, bank } = await world();
  const emp = await createEmployee({ firstName: 'ניסים', lastName: 'בן מרגי' }, o, db);
  await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'transfer', reference: '10208425', dueDate: '2026-09-08', amount: 1556481 }, o, db);
  await bank([{ txnDate: '2026-09-09', amount: -1556481, description: 'העב׳ במקבץ-נט', rawReference: '99887766', externalId: 'k1' }]);
  const rows = await attachSalaryBankHints(await listSalaryPayments({}, db), db);
  const hint = rows.find((x) => x.reference === '10208425').bank_hint;
  assert.match(hint, /אין בבנק חיוב עם האסמכתה הזו — אבל יש חיוב באותו סכום ב-2026-09-09 \(אסמכתה 99887766\)/);
});
