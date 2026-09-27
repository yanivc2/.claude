// 🔴 PRG בדף התאמת בנק. נצפה: "בטל ייבוא" רינדר את הדף במקום להפנות, הדפדפן נשאר על כתובת ה-POST,
// ושליחה חוזרת הציגה "ייבוא 18 לא נמצא" — על ייבוא שנמחק בהצלחה בלחיצה הראשונה. ו"הוסף תנועה"
// שנשלח שוב ברענון היה מוסיף את התנועה פעמיים.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { importTransactions } from '../src/services/bankTransactions.js';

let server, base;
before(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const post = (path, cookie, body = '') => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body,
});

test('ביטול ייבוא → 303; שליחה חוזרת → 303 "כבר בוטל" ולא דף שגיאה', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const cookie = `session=${createSession(o.id)}`;
  const st = await firstStore(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id])).id;
  const imp = await importTransactions(acct, [{ txnDate: '2026-09-01', amount: -100, description: 'א' }], 'csv', o, db);

  const first = await post(`/reconciliation/imports/${imp.importId}/delete`, cookie);
  assert.equal(first.status, 303);
  const loc1 = new URL(first.headers.get('location'), base);
  assert.equal(loc1.searchParams.get('account'), String(acct));
  assert.match(loc1.searchParams.get('notice'), /הייבוא בוטל: 1 תנועות נמחקו/);

  const again = await post(`/reconciliation/imports/${imp.importId}/delete`, cookie);
  assert.equal(again.status, 303);
  assert.match(new URL(again.headers.get('location'), base).searchParams.get('notice'), /כבר בוטל/);

  const page = await fetch(`${base}${again.headers.get('location')}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /כבר בוטל/);
});

test('הוספת תנועה ידנית → 303, כך שרענון לא מוסיף אותה שוב', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const cookie = `session=${createSession(o.id)}`;
  const st = await firstStore(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id])).id;
  const r = await post('/reconciliation/add', cookie,
    new URLSearchParams({ account: String(acct), txn_date: '2026-09-01', amount: '12.50', description: 'ידני' }).toString());
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/reconciliation\?account=/);
});
