// בעלים 22/10, עובדים ומשכורות: "צור לי מסנן לפי שבוע ולפי חודש למעלה משמאל לחזרה".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createEmployee, employeeTotals } from '../src/services/employees.js';
import { createSalaryPayment } from '../src/services/salaryPayments.js';
import { periodFromQuery } from '../src/lib/period.js';

let db, o, st, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  const emp = await createEmployee({ firstName: 'דנה', lastName: 'תקופה' }, o, db);
  await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: 'SAL-SEP', dueDate: '2026-09-09', amount: 100000 }, o, db);
  await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: 'SAL-OCT', dueDate: '2026-10-20', amount: 200000 }, o, db);
  const z = (await db.run("INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, drawer_credit, drawer_total, created_by) VALUES (?, '4401', '2026-10-21', 0, 0, 0, 0, ?)", [st.id, o.id])).lastInsertRowid;
  const z2 = (await db.run("INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, drawer_credit, drawer_total, created_by) VALUES (?, '4402', '2026-09-03', 0, 0, 0, 0, ?)", [st.id, o.id])).lastInsertRowid;
  await db.run("INSERT INTO z_expenses (z_report_id, expense_date, payer_name, purpose, description_type, amount, employee_id) VALUES (?, '2026-10-21', 'דנה', 'שכר', 'salary', 5000, ?)", [z, emp.id]);
  await db.run("INSERT INTO z_expenses (z_report_id, expense_date, payer_name, purpose, description_type, amount, employee_id) VALUES (?, '2026-09-03', 'דנה', 'שכר', 'salary', 7000, ?)", [z2, emp.id]);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const get = async (p) => (await fetch(base + p, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();

test('a week is Sunday–Saturday around the chosen day; a month is the whole month; nonsense filters nothing', () => {
  assert.deepEqual(periodFromQuery({ week: '2026-10-22' }), { kind: 'week', from: '2026-10-18', to: '2026-10-24', value: '2026-10-18' });
  assert.deepEqual(periodFromQuery({ month: '2026-02-01' }), { kind: 'month', from: '2026-02-01', to: '2026-02-28', value: '2026-02-01' });
  assert.equal(periodFromQuery({ week: '22/10/26' }), null);
  assert.equal(periodFromQuery({ month: '2026-13' }), null);
});

test('"הכל · שבוע · חודש" sits in the header row; a week/month narrows wages, the Z ledger and the summary together', async () => {
  let html = await get('/employees');
  const start = html.slice(html.indexOf('class="sb-side sb-start"'), html.indexOf('class="sb-center"'));
  assert.match(start, /class="period-menu no-print"/);
  assert.match(start, /name="week" data-dp-mode="week" data-dp-submit="1"/);
  assert.match(start, /name="month" data-dp-mode="month" data-dp-submit="1"/);
  assert.match(html, /SAL-SEP/); assert.match(html, /SAL-OCT/);

  // רק רובריקת "תשלומי שכר" — בורר ההחזר של "מפרעות והלוואות" (לא מסונן, בכוונה) מציע את כל תשלומי השכר.
  // (שורות ה-Z הן "שכר" ולא "מפרעה": מפרעה מסונכרנת ל-employee_advances, ו-listAdvances נתקל במגבלה ידועה של pg-mem.)
  const wages = (h) => h.slice(h.indexOf('>תשלומי שכר</h2>'), h.indexOf('<summary>הוספת עובד</summary>'));
  html = wages(await get('/employees?month=2026-10-01'));
  assert.match(html, /SAL-OCT/); assert.doesNotMatch(html, /SAL-SEP/);
  html = wages(await get('/employees?week=2026-09-07'));
  assert.match(html, /SAL-SEP/); assert.doesNotMatch(html, /SAL-OCT/);

  const oct = await employeeTotals({ storeId: st.id, scope: null, period: periodFromQuery({ month: '2026-10' }) }, db);
  const all = await employeeTotals({ storeId: st.id, scope: null }, db);
  const dana = (rows) => rows.find((r) => r.last_name === 'תקופה');
  assert.equal(dana(oct).salary, 5000, 'October only');
  assert.equal(dana(all).salary, 12000, 'no period = everything');
});

// בעלים 22/10: "גם מפרעות והלוואות לסנן לפי התקופה" — לפי תאריך המתן; כל מפרעה עם כל ההחזרים שלה (היתרה נכונה).
test('advances and loans narrow to the period by their issue date, each still carrying all its repayments', async () => {
  const { createAdvance, repayAdvance, listAdvances, openBalances } = await import('../src/services/employeeAdvances.js');
  const emp = await createEmployee({ firstName: 'יוסי', lastName: 'הלוואה' }, o, db);
  const sep = await createAdvance({ storeId: st.id, employeeId: emp.id, kind: 'loan', issuedDate: '2026-09-02', amount: 100000, method: 'transfer', reference: 'LN-SEP' }, o, db);
  await repayAdvance(sep.id, { repaidDate: '2026-10-05', amount: 30000, source: 'salary' }, o, db);
  await createAdvance({ storeId: st.id, employeeId: emp.id, kind: 'advance', issuedDate: '2026-10-12', amount: 20000, method: 'cash', reference: '' }, o, db);
  const mine = (rows) => rows.filter((a) => Number(a.employee_id) === Number(emp.id));

  const oct = mine(await listAdvances({ period: periodFromQuery({ month: '2026-10' }) }, db));
  assert.deepEqual(oct.map((a) => a.issued_date), ['2026-10-12'], 'only the one issued in October');
  const sepRows = mine(await listAdvances({ period: periodFromQuery({ month: '2026-09' }) }, db));
  assert.equal(sepRows.length, 1);
  assert.equal(sepRows[0].balance, 70000, 'an October repayment still counts against a September loan');
  const bal = (rows) => rows.find((b) => Number(b.employee_id) === Number(emp.id))?.balance;
  assert.equal(bal(await openBalances({ period: periodFromQuery({ month: '2026-10' }) }, db)), 20000);
  assert.equal(bal(await openBalances({}, db)), 90000, 'no period = every open advance');
});
