// בעלים 21/10: "כל חשבון חי בעולם משלו. אבל אם מצאת שיש אותם נתונים של מספר צ׳ק וסכום — תן התראה על כך
// בלוח הבקרה ושלח לי פוש שאבדוק" + "בודקים צ׳קים אם הסכום ומספר הצ׳ק תואם; אם אין — להעיר שיש סכום זהה עם
// מספר דומה או אותו תאריך, ואז בודקים ומאשרים או לא".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { findCheckTwins, alertCheckTwins, CHECK_TWIN_KIND } from '../src/services/checkTwins.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { similarNumbers, checkHint } from '../src/services/reconciliation.js';

let db, o, A, B, server, base;
const bank = (acc, date, amount, ref, desc = 'שיק') => db.run(
  "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, raw_reference, description, source) VALUES (?, ?, ?, ?, ?, 'scraper')",
  [acc.id, date, amount, ref, desc],
);
const twinsNotes = async () => db.many('SELECT * FROM notifications WHERE kind = ? ORDER BY id', [CHECK_TWIN_KIND]);

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

test('same check number + amount in two accounts = one finding; a fee ("עמ׳ בטול שיק") or another amount is not', async () => {
  await bank(A, '2026-08-26', -161600, '18338');
  await bank(B, '2026-08-26', -161600, '0018338');
  await bank(A, '2026-09-08', -1500, '888', "עמ' בטול שיק");
  await bank(B, '2026-09-08', -1500, '888', "עמ' בטול שיק");
  await bank(B, '2026-09-09', -99900, '18339');
  await bank(A, '2026-09-09', -11100, '18339');
  const f = await findCheckTwins(db);
  assert.equal(f.length, 1);
  assert.equal(f[0].number, '18338');
  assert.equal(f[0].amount, 161600);
  assert.deepEqual(f[0].accounts.map((a) => a.id).sort(), [A.id, B.id].sort());
});

test('a check issued in the app on one account and charged by the bank on another is a finding too', async () => {
  await db.run("INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by) VALUES (?, 'check', '27463', '2026-08-22', 230700, 'issued', ?)", [B.id, o.id]);
  await bank(A, '2026-08-23', -230700, '27463');
  assert.ok((await findCheckTwins(db)).some((t) => t.number === '27463'));
});

test('each finding alerts once: push + a dashboard line in every store involved', async () => {
  const n = await alertCheckTwins(db);
  assert.equal(n, 2);
  const notes = await twinsNotes();
  assert.equal(notes.length, 4, 'two findings × two stores');
  assert.match(notes[0].title, /צ׳ק \d+ · ₪[\d,.]+ מופיע בשני חשבונות/);
  assert.equal(await alertCheckTwins(db), 0, 'nothing new — no second push');
  assert.equal((await twinsNotes()).length, 4);

  const dash = await (await fetch(`${base}/`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=1` } })).text();
  assert.match(dash, /<h2 style="margin:0 0 \.3rem">🔔 התראות<\/h2>/);
  assert.match(dash, /<span class="badge b-blocked">צ׳ק בשני חשבונות<\/span>/);
});

test('rows the import refuses (another account) alert too — "so I can check"', async () => {
  const before = (await twinsNotes()).length;
  await bank(B, '2026-09-06', -31200, '18477');
  const r = await importTransactions(A.id, [
    { txnDate: '2026-09-06', amount: -31200, description: 'שיק', rawReference: '18477' },
    { txnDate: '2026-09-10', amount: -2000, description: 'שיק', rawReference: '32000' },
  ], 'csv', o, db);
  assert.equal(r.foreign.length, 1, 'the row was not taken in');
  const notes = await twinsNotes();
  assert.equal(notes.length, before + 1);
  assert.match(notes[notes.length - 1].title, /1 שורות של חשבון אחר לא נקלטו/);
  assert.match(notes[notes.length - 1].body, /18477 · ₪312\.00 · 06\/09\/26/);
});

test('similar numbers and the note beside a suggestion', () => {
  assert.equal(similarNumbers('31919', '31991'), true, 'two neighbours swapped');
  assert.equal(similarNumbers('31919', '31918'), true, 'one digit');
  assert.equal(similarNumbers('31919', '32159'), false);
  assert.equal(similarNumbers('31919', '319190'), false, 'different length');
  assert.equal(checkHint({ raw_reference: '31991', txn_date: '2026-09-22' }, { method: 'check', check_number: '31919', payment_date: '2026-09-22' }), 'סכום זהה · מספר דומה · אותו תאריך');
  assert.equal(checkHint({ raw_reference: '', txn_date: '2026-09-22' }, { method: 'check', check_number: '31919', payment_date: '2026-09-20' }), 'סכום זהה');
});
