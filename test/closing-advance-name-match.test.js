// בעלים 22/10 (צילום: "מקסים בחרמוב · מפרעה · מידנייט · סגירה · Z 2177 · ⚠️ חסר בדוח Z · ₪500"):
// "זה לא נכון — המפרעה מופיעה בדוח Z בהוצאות מזומן. ואני לא רואה את זה בכלל במעקב מפרעות".
// השורה בדוח ה-Z נשמרה בלי מזהה עובד (השם לא היה ברשימת הטופס — למשל עובד שמשויך לחנות אחרת), ולכן
// לא נכנסה למעקב המפרעות ולא הותאמה לשורת הסגירה. lib/employeeName.js#resolveEmployeeId.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createEmployee, closingEmployeeLines } from '../src/services/employees.js';
import { createZReport, replaceExpenses } from '../src/services/zreports.js';
import { createZClosing } from '../src/services/zclosing.js';
import { resolveZExpenseEmployees, syncZAdvances } from '../src/services/employeeAdvances.js';
import { resolveEmployeeId } from '../src/lib/employeeName.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

async function world() {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const other = await db.one('SELECT id FROM stores WHERE id <> ? ORDER BY id LIMIT 1', [st.id]);
  const max = await createEmployee({ firstName: 'מקסים', lastName: 'בחרמוב' }, o, db);
  const maxId = Number(max.id ?? max);
  // משויך לחנות אחרת בלבד — ולכן לא ברשימת "שם" של דוח Z בחנות הזו.
  await db.run('INSERT INTO employee_stores (employee_id, store_id) VALUES (?, ?)', [maxId, other.id]);
  const zr = await createZReport({ storeId: st.id, zNumber: '2177', zDate: '2026-09-08', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  await createZClosing({ employeeId: maxId, zNumber: '2177', drawerCash: 100000, storeId: st.id, counts: {}, registers: [],
    expenses: [{ kind: 'advance', employeeId: maxId, payerName: 'מקסים בחרמוב', amount: 50000, expenseDate: '2026-09-08' }] }, o, db);
  return { db, o, st, maxId, zr };
}

test('resolveEmployeeId: unique full name, else unique first name; never guesses between two', () => {
  const emps = [{ id: 1, first_name: 'מקסים', last_name: 'בחרמוב', active: 1 }, { id: 2, first_name: 'נופר', last_name: 'כ', active: 1 },
    { id: 3, first_name: 'דנה', last_name: 'א', active: 1 }, { id: 4, first_name: 'דנה', last_name: 'ב', active: 1 }];
  assert.equal(resolveEmployeeId(emps, ' מקסים  בחרמוב '), 1);
  assert.equal(resolveEmployeeId(emps, 'נופר'), 2);
  assert.equal(resolveEmployeeId(emps, 'דנה'), null);
  assert.equal(resolveEmployeeId(emps, 'מישהו'), null);
  assert.equal(resolveEmployeeId(emps, ''), null);
});

test('saving a Z advance whose name the form could not tie to an employee still attributes it', async () => {
  const { db, o, maxId, zr } = await world();
  await replaceExpenses(zr.id, [{ kind: 'advance', payerName: 'מקסים בחרמוב', employeeId: '', amount: 50000, expenseDate: '2026-09-08' }], o, db);
  const row = await db.one('SELECT id, employee_id FROM z_expenses WHERE z_report_id = ?', [zr.id]);
  assert.equal(Number(row.employee_id), maxId);
  // שמירה חוזרת של הדוח (למשל תיקון הפקדה) עם אותה שורה ובלי מזהה — לא מוחקת את השיוך.
  await db.run('UPDATE employees SET first_name = ? WHERE id = ?', ['מקס', maxId]); // השם כבר לא מזוהה — הקיים נשמר
  await replaceExpenses(zr.id, [{ rowId: row.id, kind: 'advance', payerName: 'מקסים בחרמוב', employeeId: '', amount: 50000, expenseDate: '2026-09-08' }], o, db);
  assert.equal(Number((await db.one('SELECT employee_id FROM z_expenses WHERE id = ?', [row.id])).employee_id), maxId);
  assert.deepEqual(await closingEmployeeLines({}, db), [], 'the closing line matches the Z line — nothing to flag');
});

test('an existing unattributed Z advance is repaired: tracked as an advance, and the closing stops saying "missing"', async () => {
  const { db, maxId, zr } = await world();
  await db.run(`INSERT INTO z_expenses (z_report_id, expense_date, payer_name, description_type, employee_id, amount)
                VALUES (?, '2026-09-08', 'מקסים בחרמוב', 'advance', NULL, 50000)`, [zr.id]);
  // עוד לפני התיקון — ההתאמה לסגירה כבר מזהה את העובד לפי השם.
  assert.deepEqual(await closingEmployeeLines({}, db), []);
  assert.equal(await resolveZExpenseEmployees(db), 1);
  await syncZAdvances(db);
  const adv = await db.one('SELECT employee_id, amount, issued_date FROM employee_advances WHERE z_expense_id IS NOT NULL', []);
  assert.ok(adv, 'the advance now appears in "מעקב מפרעות"');
  assert.equal(Number(adv.employee_id), maxId);
  assert.equal(Number(adv.amount), 50000);
  const audit = await db.one("SELECT details FROM audit_log WHERE action = 'zexpense.employee_resolved'", []);
  assert.match(audit.details, /מקסים בחרמוב/);
  assert.equal(await resolveZExpenseEmployees(db), 0, 'idempotent');
});

test('recorded as a manual expense on the Z → "נרשם כהוצאה ידנית", not "חסר"; truly missing → a hint of what the Z has', async () => {
  const { db, o, st, zr } = await world();
  await db.run(`INSERT INTO z_expenses (z_report_id, expense_date, payer_name, purpose, description_type, amount)
                VALUES (?, '2026-09-08', 'מקסים בחרמוב', 'מפרעה', 'manual', 50000)`, [zr.id]);
  const [kind] = await closingEmployeeLines({}, db);
  assert.equal(kind.status, 'kind');
  assert.equal(kind.z_kind, 'manual');
  const server = createApp().listen(0); await once(server, 'listening');
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/employees`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
    assert.match(html, /⚠️ בדוח Z נרשם כהוצאה ידנית/);
  } finally { server.close(); }
  await db.run("UPDATE z_expenses SET payer_name = 'אחר', amount = 50000 WHERE z_report_id = ?", [zr.id]);
  const [miss] = await closingEmployeeLines({}, db);
  assert.equal(miss.status, 'missing');
  assert.equal(miss.z_hint, 'בדוח ה-Z: אחר · ידני · ₪500.00');
});

test('a Z entered twice (same store + number): the line on either copy counts', async () => {
  const { db, o, st, maxId, zr } = await world();
  await replaceExpenses(zr.id, [{ kind: 'advance', payerName: 'מקסים בחרמוב', employeeId: maxId, amount: 50000, expenseDate: '2026-09-08' }], o, db);
  await createZReport({ storeId: st.id, zNumber: '2177', zDate: '2026-09-08', dailyTotal: 100000, drawerCash: 100000 }, o, db).catch(() => null);
  const dupCount = Number((await db.one("SELECT COUNT(*) AS n FROM z_reports WHERE z_number = '2177'", [])).n);
  if (dupCount > 1) assert.deepEqual(await closingEmployeeLines({}, db), []);
});
