// "✓ טופל" על הוצאת מזומן בידי המזכירה (בעלים, 16/10): הפעולה מתבצעת, **ננעלת** (רק הבעלים מבטל),
// נשלח לבעלים פוש + התראה עם "אשר / דחה". אישור משאיר; דחייה מחזירה את ההוצאה לרשימה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setCashExpenseSettled, unmatchedCashExpenses, pendingSettleKeys } from '../src/services/zreports.js';
import { listRequests, approveRequest, rejectRequest } from '../src/services/changeRequests.js';
import { listNotifications } from '../src/services/notifications.js';

let db, o, sec, st, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  sec = await secretary(db);
  st = await firstStore(db);
  // המזכירה צריכה הרשאה לחברה של החנות — אחרת היא לא רואה את ההוצאות בכלל (נכון, ולא נשוא הבדיקה).
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [sec.id, st.company_id]).catch(() => {});
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const anExpense = async (purpose = 'מונית') => {
  const zc = await db.run("INSERT INTO z_closings (employee_first, employee_last, store_id, z_number) VALUES ('רון','לוי',?,'4401')", [st.id]);
  return Number((await db.run(
    "INSERT INTO z_closing_expenses (closing_id, expense_date, payer_name, purpose, description_type, amount) VALUES (?, '2026-10-14', 'נהג', ?, 'manual', 7590)",
    [zc.lastInsertRowid, purpose],
  )).lastInsertRowid);
};
const isOpen = async (id) => (await unmatchedCashExpenses(null, 100, null, db)).some((r) => r.source === 'zclosing' && Number(r.id) === id);

test('secretary: the mark is applied at once, locked, and an approval request reaches the owner', async () => {
  const id = await anExpense();
  const r = await setCashExpenseSettled('zclosing', id, true, sec, null, db);
  assert.ok(r.pendingApproval, 'a request was opened');
  assert.equal(await isOpen(id), false, 'applied — off the unmatched list');
  assert.deepEqual(await pendingSettleKeys(db), [`zclosing|${id}`]);
  const [req] = (await listRequests({ status: 'pending' }, db)).filter((q) => q.action === 'cash_expense.settle');
  assert.match(req.summary, /₪75\.90 · נהג · מונית · Z 4401/);
  const notes = await listNotifications({ limit: 10 }, db);
  assert.ok(notes.some((n) => n.kind === 'approval' && n.link === `/approvals?req=${req.id}`), 'the owner is notified (bell + push)');
  await assert.rejects(() => setCashExpenseSettled('zclosing', id, false, sec, null, db), /רק הבעלים יכול לבטל/, 'locked for her');
  await approveRequest(req.id, o, db);
  assert.equal(await isOpen(id), false, 'approved → stays settled');
  assert.deepEqual(await pendingSettleKeys(db), []);
});

test('owner rejects → the expense is back on the unmatched list', async () => {
  const id = await anExpense('ציוד');
  await setCashExpenseSettled('zclosing', id, true, sec, null, db);
  const req = (await listRequests({ status: 'pending' }, db)).find((q) => q.action === 'cash_expense.settle' && Number(q.entity_id) === id);
  await rejectRequest(req.id, o, null, db);
  assert.equal(await isOpen(id), true);
  assert.equal((await db.one('SELECT settled_at FROM z_closing_expenses WHERE id = ?', [id])).settled_at, null);
});

test('owner: settles directly, no request', async () => {
  const id = await anExpense('דלק');
  const before = (await listRequests({ status: 'pending' }, db)).length;
  const r = await setCashExpenseSettled('zclosing', id, true, o, null, db);
  assert.ok(!r.pendingApproval);
  assert.equal((await listRequests({ status: 'pending' }, db)).length, before);
});

test('pages: the dashboard offers "טופל" and groups what is done; the notification offers approve/reject (the invoices-page rubric was removed, owner 18/10)', async () => {
  const id = await anExpense('חשמלאי');
  const secCookie = `session=${createSession(sec.id)}; ap_store=${st.id}`;
  const dash = await (await fetch(`${base}/`, { headers: { cookie: secCookie } })).text();
  assert.match(dash, new RegExp(`/cash-expenses/zclosing/${id}/settle`), 'the secretary sees the button');
  const r = await fetch(`${base}/cash-expenses/zclosing/${id}/settle`, {
    method: 'POST', redirect: 'manual', headers: { cookie: secCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ return_to: '/' }).toString(),
  });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /^\/\?cashNote=.*לאישור הבעלים/);
  const after = await (await fetch(`${base}${r.headers.get('location')}`, { headers: { cookie: secCookie } })).text();
  assert.match(after, /סומנו כטופלו \(\d+\)/, 'grouped at the bottom');
  assert.match(after, /⏳ ממתין לאישור/);
  const ownCookie = `session=${createSession(o.id)}`;
  const notes = await (await fetch(`${base}/notifications`, { headers: { cookie: ownCookie } })).text();
  assert.match(notes, /✓ אשר/);
  assert.match(notes, /✕ דחה/);
  const req = (await listRequests({ status: 'pending' }, db)).find((q) => Number(q.entity_id) === id);
  const ok = await fetch(`${base}/approvals/${req.id}/approve`, {
    method: 'POST', redirect: 'manual', headers: { cookie: ownCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ return_to: '/notifications' }).toString(),
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/notifications');
});

test('מרקורים: the secretary who presses "טופל" there sees that it went for approval', async () => {
  const id = await anExpense('אינסטלטור');
  const secCookie = `session=${createSession(sec.id)}; ap_store=${st.id}`;
  const r = await fetch(`${base}/cash-expenses/zclosing/${id}/settle`, {
    method: 'POST', redirect: 'manual', headers: { cookie: secCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ return_to: '/payments' }).toString(),
  });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /^\/payments\?cashNote=/);
  const page = await (await fetch(`${base}${r.headers.get('location')}`, { headers: { cookie: secCookie } })).text();
  assert.match(page, /סומן כטופל ונשלח לאישור הבעלים/);
});
