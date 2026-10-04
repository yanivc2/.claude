// "תאריך תחילת עבודה": חיובים לא מותאמים עד התאריך (כולל) מוסתרים מ"תנועות לא מותאמות" — לא
// נמחקים: צ׳ק מיידי שהונפק בתוכנה עדיין מותאם לשורה מוסתרת, ושורה שנמשכת שוב נשארת מוסתרת.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { listUnmatched, hiddenUnmatchedCount, setUnmatchedHiddenUntil } from '../src/services/bankTransactions.js';
import { autoReconcile } from '../src/services/reconciliation.js';

let server, base, db, o, acc;
const txn = (date, amount, ref) => db.run(
  "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, raw_reference, description, source) VALUES (?, ?, ?, ?, 'שיק', 'csv')",
  [acc.id, date, amount, ref],
);
const post = (u, body) => fetch(`${base}/reconciliation/hide-until`, {
  method: 'POST', redirect: 'manual', headers: { cookie: `session=${createSession(u.id)}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

before(async () => {
  db = await freshDb();
  o = await owner(db);
  acc = await accountForStore(db, 1);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('rows up to the date (inclusive) are hidden, later ones shown; clearing shows all', async () => {
  await txn('2026-07-30', -156940, '27356');
  await txn('2026-09-30', -1245840, '27829');
  await txn('2026-10-01', -91000, '27900');
  const r = await post(o, { account_id: String(acc.id), until: '2026-09-30' });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location').replace(/\+/g, ' ')), /עד 30\/09\/2026 \(כולל\) הוסתרו/);
  assert.deepEqual((await listUnmatched(acc.id, db)).map((t) => t.raw_reference), ['27900']);
  assert.equal(await hiddenUnmatchedCount(acc.id, db), 2);
  const html = await (await fetch(`${base}/reconciliation?account=${acc.id}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /מוסתרים חיובים עד <strong>30\/09\/26<\/strong>/);
  const at = html.indexOf('תנועות לא מותאמות (חובה)');
  const card = html.slice(at, html.indexOf('<h2>כל התנועות בחשבון', at));
  assert.ok(card.includes('27900') && !card.includes('27829'), 'the hidden check row is not in the unmatched list (the full statement below still has it)');
  // nothing was deleted
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?', [acc.id])).n * 1, 3);
  await post(o, { account_id: String(acc.id), until: '' });
  assert.equal((await listUnmatched(acc.id, db)).length, 3);
  await setUnmatchedHiddenUntil('2026-09-30', o, db);
});

test('a check issued in the app with an immediate date still matches its hidden debit', async () => {
  await db.run(
    "INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by) VALUES (?, 'check', '27829', '2026-09-28', 1245840, 'issued', ?)",
    [acc.id, o.id],
  );
  await autoReconcile(acc.id, o, db);
  assert.equal((await db.one("SELECT status FROM payments WHERE check_number = '27829'", [])).status, 'cleared');
});

test('only the owner may set it', async () => {
  const sec = await db.one("SELECT * FROM users WHERE role='secretary' LIMIT 1", []);
  await db.run(`UPDATE users SET permissions = '["nav_reconciliation"]' WHERE id = ?`, [sec.id]);
  const r = await post(sec, { account_id: String(acc.id), until: '2027-01-01' });
  assert.notEqual(r.status, 303);
  assert.equal(await (await import('../src/services/bankTransactions.js')).unmatchedHiddenUntil(db), '2026-09-30');
});
