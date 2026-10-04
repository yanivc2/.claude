// 🔴 נצפה: 4 התראות על אותו דוח Z בדקה — כל שמירה שלחה שתיים ("עודכן" + "פער מזומן"), והדוח
// נשמר פעמיים. עכשיו: התראה אחת לשמירה, שמירה חוזרת זהה מדולגת, ואחרי שמירה — 303 (לא render).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZReport } from '../src/services/zreports.js';

let server, base;
before(async () => { server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server && server.close());

test('שמירת דוח Z: התראה אחת, שמירה חוזרת זהה לא שולחת שוב, שינוי — כן; 303 לדף הדוח', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const zr = await createZReport({ storeId: st.id, zNumber: '3294', zDate: '2026-10-04', dailyTotal: 2000000, drawerCash: 1992000 }, o, db);
  const cookie = `session=${createSession(o.id)}`;
  const save = (drawerCash) => fetch(`${base}/reports/zreports/${zr.id}`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ store_id: String(st.id), z_number: '3294', z_date: '2026-10-04', daily_total: '20000', drawer_cash: drawerCash, drawer_credit: '0' }).toString(),
  });
  const count = async () => (await db.one("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE '%3294%'", [])).n;

  const r1 = await save('19920');
  assert.equal(r1.status, 303);
  assert.equal(r1.headers.get('location').split('?')[0], `/reports/zreports/${zr.id}`);
  assert.equal(Number(await count()), 1, 'התראה אחת — "עודכן" + הפער בתוכה');
  const n = await db.one("SELECT title, body FROM notifications WHERE title LIKE '%3294%'", []);
  assert.match(`${n.title} ${n.body}`, /פער מזומן: יתרה ע"ס ₪19,920\.00/);

  await save('19920'); // שמירה חוזרת בלי שינוי (דאבל-קליק / רענון)
  assert.equal(Number(await count()), 1, 'אותה הודעה בדיוק — מדולגת');

  const r3 = await save('10000'); // שינוי אמיתי — פער אחר
  assert.equal(r3.status, 303);
  assert.equal(Number(await count()), 2);
  const last = await db.one("SELECT title, body FROM notifications WHERE title LIKE '%3294%' ORDER BY id DESC LIMIT 1", []);
  assert.match(`${last.title} ${last.body}`, /יתרה ע"ס ₪10,000\.00(?! \(ללא שינוי\))/, 'פער שהשתנה — בלי "(ללא שינוי)"');

  const page = await fetch(`${base}${r1.headers.get('location')}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /הדוח עודכן/);
});

// 🔴 נצפה: דף ההתראות הציג 13:41 על אירוע של 16:41 שעון ישראל — created_at נשמר ב-UTC והוצג כמו שהוא.
test('דף ההתראות מציג שעון ישראל, לא UTC', async () => {
  const db = await freshDb();
  const o = await owner(db);
  await db.run("INSERT INTO notifications (title, body, created_at) VALUES ('בדיקת שעה', '', '2026-10-04 13:41:33')", []);
  const html = await (await fetch(`${base}/notifications`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /04\/10\/26 16:41/);
  assert.doesNotMatch(html, /04\/10\/26 13:41/);
});
