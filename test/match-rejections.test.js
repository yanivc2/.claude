// בעלים 21/10: "בודקים ומאשרים או לא מאשרים" + "שים פה" (מתחת לשורת "מוסתרים חיובים עד").
// "לא שלו" על הצעה להכרעה → הצ׳ק לא יוצע שוב לאותה תנועה, גם לא בהתאמה האוטומטית; "↩ החזר" מבטל.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { classify, autoReconcile, rejectSuggestions, restoreRejections, rejectionCount, rejectionsReady } from '../src/services/reconciliation.js';

let db, o, A, B, server, base;
const pay = (acc, num, amount, date) => db.run(
  "INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by) VALUES (?, 'check', ?, ?, ?, 'issued', ?)",
  [acc.id, num, date, amount, o.id],
);
const debit = (acc, date, amount, ref) => db.run(
  "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, raw_reference, description, source) VALUES (?, ?, ?, ?, 'שיק', 'scraper')",
  [acc.id, date, amount, ref],
);
const get = async (path) => (await fetch(base + path, { headers: { cookie: `session=${createSession(o.id)}; ap_store=1` } })).text();
const post = (path, body) => fetch(base + path, {
  method: 'POST',
  headers: { cookie: `session=${createSession(o.id)}; ap_store=1`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
  redirect: 'manual',
});

before(async () => {
  db = await freshDb();
  o = await owner(db);
  A = await accountForStore(db, 1);
  B = await accountForStore(db, 3);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('a rejected check is no longer offered to that bank line — not as a suggestion, not by auto-match; restore brings it back', async () => {
  assert.equal(await rejectionsReady(db), true);
  const p = (await pay(A, '31919', 230700, '2026-09-22')).lastInsertRowid;
  const t = (await debit(A, '2026-09-22', -230700, '31991')).lastInsertRowid;
  const txn = await db.one('SELECT * FROM bank_transactions WHERE id = ?', [t]);
  assert.equal((await classify(txn, db)).state, 'mismatch');

  assert.equal(await rejectSuggestions([{ txnId: t, paymentId: p }], o, db), 1);
  assert.equal(await rejectSuggestions([{ txnId: t, paymentId: p }], o, db), 0, 'a second press counts nothing');
  assert.equal((await classify(txn, db)).state, 'none');
  await autoReconcile(A.id, o, db);
  assert.equal((await db.one('SELECT status FROM payments WHERE id = ?', [p])).status, 'issued');
  assert.equal(await rejectionCount(A.id, db), 1);

  assert.equal(await restoreRejections(A.id, o, db), 1);
  assert.equal((await classify(txn, db)).state, 'mismatch');
  assert.equal(await rejectionCount(A.id, db), 0);
});

test('only an open line and a check of the SAME account can be rejected (no leakage between accounts)', async () => {
  const pB = (await pay(B, '40001', 50000, '2026-09-10')).lastInsertRowid;
  const tA = (await debit(A, '2026-09-10', -50000, '')).lastInsertRowid;
  await assert.rejects(rejectSuggestions([{ txnId: tA, paymentId: pB }], o, db), /חשבונות בנק שונים/);
});

test('UI: the bar sits above the table; each row has "לא שלו" tied to the reject form; restore appears after a reject', async () => {
  const p = (await pay(A, '32040', 118000, '2026-09-25')).lastInsertRowid;
  const t = (await debit(A, '2026-09-28', -118000, '')).lastInsertRowid;
  let html = await get(`/reconciliation?account=${A.id}`);
  const head = html.indexOf('תנועות לא מותאמות (חובה)');
  const bar = html.indexOf('class="reject-bar no-print"');
  const table = html.indexOf('data-filter-slot="autoMatchForm"');
  assert.ok(head > 0 && bar > head && table > bar, 'heading → reject bar → table');
  assert.match(html, /<button type="submit" class="small danger" id="rejectBtn" disabled>✕ דחה הצעות שסומנו \(0\)<\/button>/);
  assert.match(html, new RegExp(`<input type="checkbox" name="pair" form="rejectForm" value="${t}:${p}" data-reject-pick /> לא שלו`));
  assert.doesNotMatch(html, /↩ החזר/);

  const r = await post('/reconciliation/reject', { account_id: String(A.id), pair: `${t}:${p}` });
  assert.equal(r.status, 303);
  assert.match(new URL(r.headers.get('location'), base).searchParams.get('notice'), /נדחו 1 הצעות/);
  html = await get(`/reconciliation?account=${A.id}`);
  assert.doesNotMatch(html, new RegExp(`value="${t}:${p}"`), 'the rejected suggestion is gone');
  assert.match(html, /↩ החזר 1 הצעות שנדחו/);

  const back = await post('/reconciliation/reject/restore', { account_id: String(A.id) });
  assert.match(new URL(back.headers.get('location'), base).searchParams.get('notice'), /הוחזרו 1 הצעות/);
  assert.match(await get(`/reconciliation?account=${A.id}`), new RegExp(`value="${t}:${p}"`));
});

test('a forged pair from another store is refused (404), and nothing is recorded', async () => {
  const pB = (await pay(B, '40002', 70000, '2026-09-11')).lastInsertRowid;
  const tB = (await debit(B, '2026-09-11', -70000, '')).lastInsertRowid;
  const r = await post('/reconciliation/reject', { account_id: String(A.id), pair: `${tB}:${pB}` });
  assert.equal(r.status, 404);
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM bank_match_rejections WHERE bank_transaction_id = ?', [tB])).n * 1, 0);
});
