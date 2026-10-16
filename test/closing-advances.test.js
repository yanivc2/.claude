// מפרעה/שכר מסגירת Z בדף העובדים (בעלים, 16/10): "עובד קיבל מפרעה במזומן בחנות → נרשם בדוח קופה →
// בסגירת ה-Z מזינים את ההוצאות → זה מגיע למשרד, נספר שוב ומוזן לדוח Z". אותה מפרעה בשני הטפסים;
// דוח ה-Z הוא המקור, ושורת סגירה מוצגת רק כשהיא לא בו — ממתינה, חסרה, או בסוג אחר. לעולם לא פעמיים.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZReport } from '../src/services/zreports.js';
import { closingEmployeeLines, employeeTotals } from '../src/services/employees.js';
import { syncZAdvances, listAdvances } from '../src/services/employeeAdvances.js';

let db, o, st, emp, emp2, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  emp = Number((await db.run("INSERT INTO employees (first_name, last_name) VALUES ('אדם', 'כהן')", [])).lastInsertRowid);
  emp2 = Number((await db.run("INSERT INTO employees (first_name, last_name) VALUES ('דנה', 'לוי')", [])).lastInsertRowid);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const closing = async (z, lines) => {
  const id = Number((await db.run("INSERT INTO z_closings (employee_first, employee_last, store_id, z_number) VALUES ('ק', 'ופאי', ?, ?)", [st.id, z])).lastInsertRowid);
  for (const [kind, e, amount] of lines) {
    await db.run('INSERT INTO z_closing_expenses (closing_id, expense_date, description_type, employee_id, amount) VALUES (?, ?, ?, ?, ?)', [id, '2026-09-05', kind, e, amount]);
  }
  return id;
};
const zreport = async (z, lines) => {
  const zr = await createZReport({ storeId: st.id, zNumber: z, zDate: '2026-09-05', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  for (const [kind, e, amount] of lines) {
    await db.run('INSERT INTO z_expenses (z_report_id, expense_date, description_type, employee_id, amount) VALUES (?, ?, ?, ?, ?)', [zr.id, '2026-09-05', kind, e, amount]);
  }
  return zr.id;
};
const linesFor = async (z) => (await closingEmployeeLines({}, db)).filter((r) => String(r.z_number) === z);

test('the office entered it too → the closing line is hidden (one advance, not two)', async () => {
  await closing('7001', [['advance', emp, 100000]]);
  await zreport('7001', [['advance', emp, 100000]]);
  assert.equal((await linesFor('7001')).length, 0);
});

test('no Z report yet → "pending", counted in the totals (there is no other copy)', async () => {
  await closing('7002', [['advance', emp2, 50000]]);
  const l = await linesFor('7002');
  assert.equal(l.length, 1);
  assert.equal(l[0].status, 'pending');
  const t = (await employeeTotals({}, db)).find((e) => Number(e.id) === emp2);
  assert.equal(t.advances, 50000);
});

test('the Z report exists without it → "missing" (shown, not counted)', async () => {
  await closing('7003', [['advance', emp, 30000]]);
  const zId = await zreport('7003', []);
  const l = await linesFor('7003');
  assert.equal(l[0].status, 'missing');
  assert.equal(l[0].z_report_id, zId);
});

test('advance at the register, salary at the office → "kind" (the debt went missing)', async () => {
  await closing('7004', [['advance', emp, 77700]]);
  await zreport('7004', [['salary', emp, 77700]]);
  const l = await linesFor('7004');
  assert.equal(l[0].status, 'kind');
  assert.equal(l[0].z_kind, 'salary');
});

test('a closing saved twice for the same Z — only the latest counts', async () => {
  await closing('7005', [['advance', emp2, 20000]]);
  await closing('7005', [['advance', emp2, 20000]]);
  assert.equal((await linesFor('7005')).length, 1);
});

test('the debt book stays fed by the Z report only — a closing line never becomes a second debt', async () => {
  await syncZAdvances(db);
  const advs = await listAdvances({}, db);
  const z7001 = advs.filter((a) => Number(a.employee_id) === emp && Number(a.amount) === 100000);
  assert.equal(z7001.length, 1, 'once, from the Z report');
  assert.equal(advs.filter((a) => Number(a.amount) === 50000).length, 0, 'the pending closing line is not a debt yet');
});

test('page: the tracking table shows the closing lines with their status, and the debt card says so', async () => {
  const html = await (await fetch(`${base}/employees`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /סגירה · Z 7002<\/a>/);
  assert.match(html, /ממתין לדוח Z/);
  assert.match(html, /⚠️ חסר בדוח Z/);
  assert.match(html, /⚠️ בדוח Z נרשם כשכר/);
  assert.doesNotMatch(html, /סגירה · Z 7001/, 'matched → not shown twice');
  assert.match(html, /מפרעות מסגירת Z \([^)]*\) ממתינות לדוח Z/);
  assert.match(html, /מפרעות נרשמו בסגירת Z ו<strong>לא נרשמו כמפרעה בדוח Z<\/strong>/);
});

test('scoped to the closing\'s store — another branch never sees it', async () => {
  const other = await db.one('SELECT id FROM stores WHERE id <> ? ORDER BY id LIMIT 1', [st.id]);
  assert.ok(other, 'seed has a second store');
  const mine = await closingEmployeeLines({ storeId: st.id }, db);
  const theirs = await closingEmployeeLines({ storeId: other.id }, db);
  assert.ok(mine.length > 0);
  assert.equal(theirs.length, 0);
  const scoped = await closingEmployeeLines({ scope: { companyIds: [-1], storeIds: [-1] } }, db);
  assert.equal(scoped.length, 0, 'out-of-scope company/store → nothing');
});
