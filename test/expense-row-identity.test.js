// שמירה של דוח Z / סגירת Z מעדכנת שורת הוצאה קיימת **במקומה** (בעלים, 16/10 — אחרי ששינה בדוח Z 3290
// שורת שכר למפרעה). קודם כל שמירה מחקה ויצרה את כל השורות, ונמדד: מפרעה שנרשם עליה החזר **הוכפלה**
// (₪1,000 + ₪700 יתרה), סימון "✓ טופל" נמחק, וקישור צ׳ק שכר התנתק (ON DELETE SET NULL).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZReport, replaceExpenses, listExpenses } from '../src/services/zreports.js';
import { createZClosing, updateZClosing, listClosingExpenses } from '../src/services/zclosing.js';
import { syncZAdvances, listAdvances, repayAdvance } from '../src/services/employeeAdvances.js';

let db, o, st, emp, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  emp = Number((await db.run("INSERT INTO employees (first_name, last_name) VALUES ('אדם', 'כהן')", [])).lastInsertRowid);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const asForm = (rows) => rows.map((r) => ({
  rowId: r.id, kind: r.description_type, expenseDate: r.expense_date, payerName: r.payer_name, purpose: r.purpose,
  employeeId: r.employee_id, amount: Number(r.amount), invoiceId: r.invoice_id,
}));

test('Z report: re-saving keeps the rows — no doubled advance, the "טופל" mark and the salary link survive', async () => {
  const zr = await createZReport({ storeId: st.id, zNumber: '3290', zDate: '2026-09-05', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  await replaceExpenses(zr.id, [
    { kind: 'advance', employeeId: emp, amount: 100000, expenseDate: '2026-09-05' },
    { kind: 'petty', payerName: 'פריטה', amount: 5000, expenseDate: '2026-09-05' },
    { kind: 'salary', employeeId: emp, amount: 250000, expenseDate: '2026-09-05' },
  ], o, db);
  const rows = await listExpenses(zr.id, db);
  const petty = rows.find((r) => r.description_type === 'petty');
  const salary = rows.find((r) => r.description_type === 'salary');
  await db.run("UPDATE z_expenses SET settled_at = '2026-09-06 10:00:00' WHERE id = ?", [petty.id]);
  const sp = Number((await db.run(
    "INSERT INTO salary_payments (store_id, employee_id, method, reference, due_date, amount, cashed, cash_z_expense_id, created_by) VALUES (?, ?, 'check', '901', '2026-09-05', 250000, 1, ?, ?)",
    [st.id, emp, salary.id, o.id],
  )).lastInsertRowid);
  await syncZAdvances(db);
  const [adv] = (await listAdvances({}, db)).filter((a) => Number(a.employee_id) === emp);
  await repayAdvance(adv.id, { amount: 30000, repaidDate: '2026-09-10', source: 'cash' }, o, db);

  // the office fixes something else and saves the whole form again (same rows, with their ids)
  await replaceExpenses(zr.id, asForm(await listExpenses(zr.id, db)), o, db);
  await syncZAdvances(db);

  const advs = (await listAdvances({}, db)).filter((a) => Number(a.employee_id) === emp);
  assert.equal(advs.length, 1, 'still ONE advance');
  assert.equal(advs[0].balance, 70000, 'with its repayment');
  assert.equal((await db.one('SELECT settled_at FROM z_expenses WHERE id = ?', [petty.id])).settled_at, '2026-09-06 10:00:00');
  assert.equal(Number((await db.one('SELECT cash_z_expense_id FROM salary_payments WHERE id = ?', [sp])).cash_z_expense_id), salary.id);
});

test('Z report: a changed row is updated in place (salary → advance), a removed row is deleted, a new row is added', async () => {
  const zr = await createZReport({ storeId: st.id, zNumber: '3291', zDate: '2026-09-06', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  await replaceExpenses(zr.id, [
    { kind: 'salary', employeeId: emp, amount: 100000, expenseDate: '2026-09-06' },
    { kind: 'manual', purpose: 'דלק', amount: 4000, expenseDate: '2026-09-06' },
  ], o, db);
  const [s, m] = await listExpenses(zr.id, db);
  await replaceExpenses(zr.id, [
    { rowId: s.id, kind: 'advance', employeeId: emp, amount: 100000, expenseDate: '2026-09-06' },
    { kind: 'manual', purpose: 'חלב', amount: 1500, expenseDate: '2026-09-06' },
  ], o, db);
  const after = await listExpenses(zr.id, db);
  assert.equal(after.length, 2);
  assert.ok(after.some((r) => Number(r.id) === Number(s.id) && r.description_type === 'advance'), 'same id, new kind');
  assert.ok(!after.some((r) => Number(r.id) === Number(m.id)), 'the removed row is gone');
  await syncZAdvances(db);
  assert.equal((await listAdvances({}, db)).filter((a) => Number(a.amount) === 100000 && Number(a.employee_id) === emp && a.issued_date === '2026-09-06').length, 1,
    'the changed row becomes the advance — the owner\'s Z 3290 case');
});

test('register closing: editing keeps the rows — the salary-check link and the "טופל" mark survive', async () => {
  const input = (expenses) => ({
    employeeFirst: 'רון', employeeLast: 'לוי', storeId: st.id, zNumber: '3292', drawerCash: 0,
    startedAt: '2026-09-07 09:00', counts: { 200: 1 }, expenses,
  });
  await createZClosing(input([
    { kind: 'salary', employeeId: emp, amount: 120000, expenseDate: '2026-09-07' },
    { kind: 'petty', payerName: 'פריטה', amount: 2000, expenseDate: '2026-09-07' },
  ]), o, db);
  const id = Number((await db.one('SELECT id FROM z_closings ORDER BY id DESC LIMIT 1', [])).id);
  const rows = await listClosingExpenses(id, db);
  const sal = rows.find((r) => r.description_type === 'salary');
  const pet = rows.find((r) => r.description_type === 'petty');
  await db.run("UPDATE z_closing_expenses SET settled_at = '2026-09-08 08:00:00' WHERE id = ?", [pet.id]);
  const sp = Number((await db.run(
    "INSERT INTO salary_payments (store_id, employee_id, method, reference, due_date, amount, cashed, cash_expense_id, created_by) VALUES (?, ?, 'check', '902', '2026-09-07', 120000, 1, ?, ?)",
    [st.id, emp, sal.id, o.id],
  )).lastInsertRowid);
  await updateZClosing(id, input(asForm(rows)), o, db);
  assert.equal(Number((await db.one('SELECT cash_expense_id FROM salary_payments WHERE id = ?', [sp])).cash_expense_id), Number(sal.id));
  assert.equal((await db.one('SELECT settled_at FROM z_closing_expenses WHERE id = ?', [pet.id])).settled_at, '2026-09-08 08:00:00');
  const json = (await db.one('SELECT expenses FROM z_closings WHERE id = ?', [id])).expenses;
  assert.ok(!/rowId/.test(json), 'the row id is the form\'s, not stored in the closing JSON');
});

test('both edit forms send each row\'s id (and an empty one for new rows)', async () => {
  const zr = (await db.one("SELECT id FROM z_reports WHERE z_number = '3290'", []));
  const cookie = `session=${createSession(o.id)}`;
  const zhtml = await (await fetch(`${base}/reports/zreports/${zr.id}`, { headers: { cookie } })).text();
  const ids = (await listExpenses(zr.id, db)).map((r) => Number(r.id));
  for (const i of ids) assert.match(zhtml, new RegExp(`name="expense_row_id" value="${i}"`));
  assert.match(zhtml, /name="expense_row_id" value=""/);
  const cid = Number((await db.one("SELECT id FROM z_closings WHERE z_number = '3292'", [])).id);
  const chtml = await (await fetch(`${base}/zclosing/${cid}`, { headers: { cookie } })).text();
  for (const r of await listClosingExpenses(cid, db)) assert.match(chtml, new RegExp(`name="expense_row_id" value="${r.id}"`));
});
