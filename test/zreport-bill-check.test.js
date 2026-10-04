// דף עריכת דוח Z: "בדיקת שטרות מול סגירת Z" מעל עריכת הדוח, מצומצמת כברירת מחדל; שמירתה היא
// PRG (303) שחוזר לרובריקה פתוחה — קודם render במקום השאיר את הדפדפן על כתובת POST.
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

test('בדיקת שטרות: מעל עריכת הדוח, סגורה כברירת מחדל, ופתוחה אחרי שמירה', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const zr = await createZReport({ storeId: st.id, zNumber: '4401', zDate: '2026-10-04', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  const cookie = `session=${createSession(o.id)}`;

  const html = await (await fetch(`${base}/reports/zreports/${zr.id}`, { headers: { cookie } })).text();
  const bills = html.indexOf('id="bill-check"');
  const edit = html.indexOf('<h2>עריכת דוח</h2>');
  assert.ok(bills > 0 && edit > 0 && bills < edit, 'בדיקת השטרות לפני עריכת הדוח');
  assert.match(html, /<details class="card collapse no-print" id="bill-check">/, 'סגורה — בלי open');

  const r = await fetch(`${base}/reports/zreports/${zr.id}/verify-bills`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ mgr_count_200: '1' }).toString(),
  });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/reports\/zreports\/\d+\?open=bills&notice=/);
  const after = await (await fetch(`${base}${loc.split('#')[0]}`, { headers: { cookie } })).text();
  assert.match(after, /id="bill-check" open>/);
  assert.match(after, /ספירת השטרות נשמרה/);
});
