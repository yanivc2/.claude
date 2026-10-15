// בדיקת שיוך לחשבון: רצף יתרות שלם = אין עירבוב; שורה של חשבון אחר שוברת את הרצף, תנועה זהה
// בשני חשבונות מסומנת, וחיוב של צ׳ק מפנקס של חשבון אחר מסומן.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { accountIntegrity } from '../src/services/accountIntegrity.js';

let server, base, db, o, A, B;
const txn = (acc, date, amount, bal, ref = null, desc = 'שיק') => db.run(
  "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, raw_reference, balance_after, description, source) VALUES (?, ?, ?, ?, ?, ?, 'csv')",
  [acc.id, date, amount, ref, bal, desc],
);

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

test('a clean account: the balance chain holds every day, nothing flagged (intra-day order does not matter)', async () => {
  await txn(A, '2026-07-28', 100000, 500000, '1');
  await txn(A, '2026-07-30', -20000, 460000, '27356');   // file order differs from the bank's:
  await txn(A, '2026-07-30', -20000, 480000, '27348');   // 480k came first in the bank
  await txn(A, '2026-07-31', 5000, 465000, '2');
  const r = await accountIntegrity(A.id, db);
  assert.equal(r.breaks.length, 0);
  assert.equal(r.daysChecked, 2);
  assert.equal(r.duplicates.length, 0);
  assert.equal(r.foreignChecks.length, 0);
});

test('a row of another account breaks the chain, and the same row in two accounts is flagged', async () => {
  await txn(A, '2026-08-02', -164437, 9876543, '27359');  // from B's statement (B's balance level)
  await txn(B, '2026-08-02', -164437, 9876543, '27359');  // …which was also imported to B
  await txn(A, '2026-08-03', -1000, 464000, '3');          // A's own next row
  const r = await accountIntegrity(A.id, db);
  assert.ok(r.breaks.some((b) => b.date === '2026-08-02'), 'the foreign day breaks the chain');
  assert.ok(r.breaks.some((b) => b.date === '2026-08-03'), 'and A\'s own next day no longer connects');
  assert.equal(r.duplicates.length, 1);
  assert.equal(r.duplicates[0].txn.raw_reference, '27359');
});

test('a debit that is a check from another account\'s checkbook is flagged; the page renders', async () => {
  await db.run(
    "INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by) VALUES (?, 'check', '27348', '2026-07-20', 20000, 'issued', ?)",
    [B.id, o.id],
  );
  const r = await accountIntegrity(A.id, db);
  assert.equal(r.foreignChecks.length, 1);
  assert.equal(r.foreignChecks[0].checkNumber, '27348');
  const html = await (await fetch(`${base}/reconciliation/integrity?account=${A.id}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /בדיקת שיוך לחשבון/);
  assert.match(html, /נמצאו ממצאים שדורשים בדיקה/);
  assert.match(html, /27348/);
  const clean = await (await fetch(`${base}/reconciliation/integrity?account=${(await accountForStore(db, 4)).id}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(clean, /לא נמצא שום סימן לתנועה של חשבון אחר/);
});

// בעלים (15/10, מידנייט): 66 שורות קובץ מול ~8 תנועות ביום מהסוכן — הקובץ כלל רק חלק מכל יום,
// והבדיקה הציגה "שבר" ב-25 ימים בהפרשים שמתקזזים, בלי שום תנועה זרה.
test('a file holding only PART of a day (the rest pulled, no balance) is not a break — the day is not checked', async () => {
  const C = await accountForStore(db, 2);
  const pull = (date, amount) => db.run(
    "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, source, external_id) VALUES (?, ?, ?, 'x', 'scraper', ?)",
    [C.id, date, amount, `scr:hapoalimBiz:1:${date}:${amount}:${Math.random()}`],
  );
  await txn(C, '2026-08-12', -1000, 100000, 'a');
  // 13/08 in the bank: -500 (pulled), then -2000 (file, balance 97500), then +7000 (pulled) → close 104500
  await pull('2026-08-13', -500);
  await txn(C, '2026-08-13', -2000, 97500, 'b');
  await pull('2026-08-13', 7000);
  await txn(C, '2026-08-14', -100, 104400, 'c');
  const r = await accountIntegrity(C.id, db);
  assert.equal(r.breaks.length, 0, 'no false alarm');
  assert.deepEqual(r.partialDays, ['2026-08-13']);
  const html = await (await fetch(`${base}/reconciliation/integrity?account=${C.id}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /ימים לא נבדקו ברצף היתרות/);
});

test('a break says what it probably is: a missing line in the window, or a row we have that the bank does not', async () => {
  const D = await accountForStore(db, 4);
  await txn(D, '2026-09-01', -100, 50000, 'a');
  await txn(D, '2026-09-04', -200, 53538, 'b'); // the bank also had +₪37.38 we never imported
  let r = await accountIntegrity(D.id, db);
  const b1 = r.breaks.find((b) => b.date === '2026-09-04');
  assert.ok(b1 && b1.since === '2026-09-01');
  assert.equal(b1.diff, 3738);
  assert.equal(b1.suspects.length, 0, 'nothing of ours explains it → a missing line');
  // now the opposite: a stray debit of ours that the bank never had
  await txn(D, '2026-09-08', -999, null, 'c');
  await txn(D, '2026-09-09', -50, 53488, 'd'); // the bank: 53,538 − 50
  r = await accountIntegrity(D.id, db);
  const b2 = r.breaks.find((b) => b.date === '2026-09-09');
  assert.ok(b2 && b2.suspects.some((x) => Number(x.amount) === -999), 'the stray row is named');
  const html = await (await fetch(`${base}/reconciliation/integrity?account=${D.id}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /חסרה כנראה תנועה של/);
  assert.match(html, /שורה שכנראה <strong>מיותרת<\/strong> אצלנו/);
});

