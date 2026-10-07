// "בחינת תנועה": חיוב בבנק מול מה שיש במערכת עם אותו מספר — פתוח ותואם / סכום אחר / חשבון אחר /
// לא נמצא; הסקופ חל על התנועה עצמה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { inspectBankTxn } from '../src/services/txnInspect.js';

let server, base, db, o, A, B;
const txn = async (acc, ref, amount) => (await db.run(
  "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, raw_reference, description, source) VALUES (?, '2026-10-01', ?, ?, 'שיק', 'scraper')",
  [acc.id, amount, ref],
)).lastInsertRowid;
const pay = (acc, no, amount, status = 'issued') => db.run(
  "INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by) VALUES (?, 'check', ?, '2026-09-30', ?, ?, ?)",
  [acc.id, no, amount, status, o.id],
);
const page = async (id, store) => fetch(`${base}/reconciliation/txn/${id}`, { headers: { cookie: `session=${createSession(o.id)}${store ? `; ap_store=${store}` : ''}` } });

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

test('verdicts: matchable · amount differs · other account · not found', async () => {
  await pay(A, '32527', 185400);
  await pay(A, '32523', 2035000);          // the bank charged 20,354.30
  await pay(B, '29364', 271400);           // issued from ANOTHER account
  const t1 = await txn(A, '32527', -185400);
  const t2 = await txn(A, '32523', -2035430);
  const t3 = await txn(A, '29364', -271400);
  const t4 = await txn(A, '31627', -446300);
  assert.equal((await inspectBankTxn(t1, null, db)).payments[0].verdict, 'matchable');
  assert.equal((await inspectBankTxn(t2, null, db)).payments[0].verdict, 'amount_differs');
  assert.equal((await inspectBankTxn(t3, null, db)).payments[0].verdict, 'other_account');
  const r4 = await inspectBankTxn(t4, null, db);
  assert.equal(r4.payments.length + r4.salary.length, 0);

  const h1 = await (await page(t1)).text();
  assert.match(h1, /אפשר לאשר את הפירעון/);
  assert.match(h1, /name="payment_id"/);
  assert.match(await (await page(t3)).text(), /הונפק מחשבון בנק אחר/);
  assert.match(await (await page(t4)).text(), /לא נמצא במערכת צ׳ק או תשלום עם המספר הזה/);
  // the unmatched list links each reference to this page, and the table is centred
  const list = await (await fetch(`${base}/reconciliation?account=${A.id}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(list, new RegExp(`href="/reconciliation/txn/${t4}"`));
  assert.match(list, /class="sortable filterable tbl-center"/);
});

test('a transaction of another store is 404 under the active store', async () => {
  const tB = await txn(B, '77777', -1000);
  assert.equal((await page(tB, 1)).status, 404);
  assert.equal((await page(tB, 3)).status, 200);
});
