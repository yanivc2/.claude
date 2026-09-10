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
