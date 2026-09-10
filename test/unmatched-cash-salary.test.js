import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { unmatchedCashExpenses } from '../src/services/zreports.js';

// 🔴 המקרה של אורית: שכר שיצא במזומן מהקופה ולא נקשר לשום רישום שכר — הוא בדיוק "תשלום מזומן
// ללא התאמה", והרשימה החריגה אותו לגמרי לפי סוג ("זה שכר, זה מנוהל בדף עובדים"). "מנוהל בדף
// עובדים" אינו "הותאם": הכסף יצא ואף שורה לא אומרת עבור מה.
async function seedClosingExpense(x, storeId, user, { kind = 'salary', amount = 500000, employeeId = null } = {}) {
  const zc = await x.run(
    `INSERT INTO z_closings (employee_first, employee_last, store_id, z_number, drawer_cash, created_by)
     VALUES ('רון','לוי',?,'2179',120000,?)`, [storeId, user.id]);
  const e = await x.run(
    `INSERT INTO z_closing_expenses (closing_id, expense_date, payer_name, purpose, description_type, employee_id, amount)
     VALUES (?, '2026-09-10', 'אורית', ?, ?, ?, ?)`,
    [zc.lastInsertRowid, kind === 'salary' ? 'שכר' : 'מפרעה', kind, employeeId, amount]);
  return { closingId: zc.lastInsertRowid, expenseId: e.lastInsertRowid };
}

test('שכר במזומן שלא הותאם — מופיע ברשימה', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const store = await firstStore(x);
  await seedClosingExpense(x, store.id, user);

  const rows = await unmatchedCashExpenses(null, 20, null, x);
  const salary = rows.find((r) => r.description_type === 'salary');
  assert.ok(salary, 'שכר במזומן ללא קישור חייב להופיע');
  assert.equal(salary.payer_name, 'אורית');
  assert.equal(salary.amount, 500000);
});

test('אותו שכר נעלם ברגע שהוא נקשר לרישום שכר', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const store = await firstStore(x);
  const emp = await x.run(`INSERT INTO employees (first_name, last_name) VALUES ('אורית','כהן')`, []);
  const { expenseId } = await seedClosingExpense(x, store.id, user, { employeeId: emp.lastInsertRowid });

  assert.ok((await unmatchedCashExpenses(null, 20, null, x)).some((r) => r.description_type === 'salary'));

  await x.run(
    `INSERT INTO salary_payments (employee_id, store_id, due_date, amount, method, cash_expense_id, cashed, created_by)
     VALUES (?, ?, '2026-09-10', 500000, 'cash', ?, 1, ?)`,
    [emp.lastInsertRowid, store.id, expenseId, user.id]);

  const after = await unmatchedCashExpenses(null, 20, null, x);
  assert.ok(!after.some((r) => r.description_type === 'salary'), 'אחרי הקישור השורה יוצאת מהרשימה');
});

test('מפרעה מדוח Z משוקפת אוטומטית לספר המפרעות — ולכן אינה "ללא התאמה"', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const store = await firstStore(x);
  const emp = await x.run(`INSERT INTO employees (first_name, last_name) VALUES ('אורית','כהן')`, []);
  const zr = await x.run(`INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, created_by)
                          VALUES (?, '2180', '2026-09-10', 100000, 50000, ?)`, [store.id, user.id]);
  const ex = await x.run(
    `INSERT INTO z_expenses (z_report_id, expense_date, payer_name, purpose, description_type, employee_id, amount)
     VALUES (?, '2026-09-10', 'אורית', 'מפרעה', 'advance', ?, 20000)`,
    [zr.lastInsertRowid, emp.lastInsertRowid]);

  assert.ok((await unmatchedCashExpenses(null, 20, null, x)).some((r) => r.description_type === 'advance'));

  await x.run(
    `INSERT INTO employee_advances (employee_id, store_id, kind, issued_date, amount, z_expense_id)
     VALUES (?, ?, 'advance', '2026-09-10', 20000, ?)`,
    [emp.lastInsertRowid, store.id, ex.lastInsertRowid]);

  assert.ok(!(await unmatchedCashExpenses(null, 20, null, x)).some((r) => r.description_type === 'advance'));
});

test('🔴 מפתח הקישור הוא source|id — id בסגירה אינו id בדוח', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const store = await firstStore(x);
  const emp = await x.run(`INSERT INTO employees (first_name, last_name) VALUES ('אורית','כהן')`, []);
  // הוצאת סגירה שקושרה, והוצאת דוח Z שלא — אם המפתח היה id לבד, השנייה הייתה נעלמת בטעות.
  const { expenseId } = await seedClosingExpense(x, store.id, user, { employeeId: emp.lastInsertRowid });
  await x.run(
    `INSERT INTO salary_payments (employee_id, store_id, due_date, amount, method, cash_expense_id, cashed, created_by)
     VALUES (?, ?, '2026-09-10', 500000, 'cash', ?, 1, ?)`,
    [emp.lastInsertRowid, store.id, expenseId, user.id]);

  const zr = await x.run(`INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, created_by)
                          VALUES (?, '2181', '2026-09-10', 100000, 50000, ?)`, [store.id, user.id]);
  // אותו מזהה מספרי כמו הוצאת הסגירה, במרחב מזהים אחר, ובסכום אחר כדי לא להיתפס בכלל הסכום
  await x.run(
    `INSERT INTO z_expenses (id, z_report_id, expense_date, payer_name, purpose, description_type, amount)
     VALUES (?, ?, '2026-09-10', 'נופר', 'ציוד משרדי', 'manual', 4321)`,
    [expenseId, zr.lastInsertRowid]);

  const rows = await unmatchedCashExpenses(null, 20, null, x);
  assert.ok(rows.some((r) => r.source === 'zreport' && r.purpose === 'ציוד משרדי'),
    'שורת דוח Z לא נעלמת בגלל קישור של שורת סגירה עם אותו מזהה');
});

test('שם העובד זמין לתצוגה', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const store = await firstStore(x);
  const emp = await x.run(`INSERT INTO employees (first_name, last_name) VALUES ('אורית','כהן')`, []);
  await seedClosingExpense(x, store.id, user, { employeeId: emp.lastInsertRowid });
  const r = (await unmatchedCashExpenses(null, 20, null, x)).find((v) => v.description_type === 'salary');
  assert.equal(`${r.emp_first} ${r.emp_last}`, 'אורית כהן');
});

// ── ביטול ההסתרה לפי סכום + סימון ידני ────────────────────────────────────────
import { setCashExpenseSettled, settledCashExpenses, cashSettleReady } from '../src/services/zreports.js';

test('🔴 תשלום מזומן באותו סכום כבר אינו מעלים הוצאה', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const store = await firstStore(x);
  const acc = await accountForStore(x, store.id);
  const { expenseId } = await seedClosingExpense(x, store.id, user, { kind: 'manual', amount: 30000 });
  await x.run(
    `UPDATE z_closing_expenses SET purpose = 'פריטה' WHERE id = ?`, [expenseId]);

  // תשלום מזומן ישן לגמרי, באותו סכום — בעבר הוא היה מעלים את ההוצאה בשקט.
  await x.run(
    `INSERT INTO payments (bank_account_id, method, payer_name, amount, payment_date, status, created_by)
     VALUES (?, 'cash', 'מישהו אחר', 30000, '2026-01-01', 'issued', ?)`, [acc.id, user.id]);

  const rows = await unmatchedCashExpenses(null, 20, null, x);
  assert.ok(rows.some((r) => Number(r.id) === Number(expenseId)),
    'שורה יוצאת מהרשימה רק בדרך מפורשת — לא בגלל סכום זהה במקרה');
});

test('סימון "טופל" מוריד מהרשימה, וביטול הסימון מחזיר', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const store = await firstStore(x);
  const { expenseId } = await seedClosingExpense(x, store.id, user, { kind: 'manual', amount: 30000 });

  assert.equal(await cashSettleReady(x), true);
  assert.ok((await unmatchedCashExpenses(null, 20, null, x)).some((r) => Number(r.id) === Number(expenseId)));

  await setCashExpenseSettled('zclosing', expenseId, true, user, null, x);
  assert.ok(!(await unmatchedCashExpenses(null, 20, null, x)).some((r) => Number(r.id) === Number(expenseId)));

  // הפיך — והשורה נשמרת, לא נמחקת
  const settled = await settledCashExpenses(null, 30, null, x);
  const mine = settled.find((r) => Number(r.id) === Number(expenseId) && r.source === 'zclosing');
  assert.ok(mine, 'השורה מופיעה ברשימת "סומנו כטופלו"');
  assert.ok(mine.settled_at, 'נשמרה חותמת זמן');

  await setCashExpenseSettled('zclosing', expenseId, false, user, null, x);
  assert.ok((await unmatchedCashExpenses(null, 20, null, x)).some((r) => Number(r.id) === Number(expenseId)),
    'ביטול הסימון מחזיר את השורה');
  assert.equal((await settledCashExpenses(null, 30, null, x)).length, 0);
});

test('🔴 סימון מכבד את הפרדת החנויות — מזהה מבקשה לא יגע בשורה של חנות אחרת', async () => {
  const x = await freshDb();
  const user = await owner(x);
  const stores = await x.many('SELECT * FROM stores ORDER BY id', []);
  if (stores.length < 2) return; // הזרע לא כולל שתי חנויות
  const { expenseId } = await seedClosingExpense(x, stores[1].id, user, { kind: 'manual', amount: 30000 });

  await assert.rejects(
    () => setCashExpenseSettled('zclosing', expenseId, true, user, { companyIds: null, storeIds: [stores[0].id] }, x),
    /לא נמצאה/,
  );
  // ובלי סקופ — עובר
  await setCashExpenseSettled('zclosing', expenseId, true, user, { companyIds: null, storeIds: [stores[1].id] }, x);
});

test('מקור לא מוכר נדחה', async () => {
  const x = await freshDb();
  const user = await owner(x);
  await assert.rejects(() => setCashExpenseSettled('../etc', 1, true, user, null, x), /מקור הוצאה לא מוכר/);
});
