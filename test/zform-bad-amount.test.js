// בעלים 11/11 ("תבצע את שני התיקונים"):
//  (1) סכום לא תקין בדוח Z — 08/11 הוקלד "25841.118023.18" ב"סה"כ (יומי Z)", `toAgorot` זרק שגיאה רגילה,
//      הוצג דף שגיאה וכל מה שהוקלד אבד. עכשיו: הדפדפן עוצר לפני השליחה ומסמן את השדה, והשרת (רשת ביטחון)
//      מחזיר הודעה בראש הטופס עם שם השדה — לא דף שגיאה — ולא שומר כלום.
//  (2) דף התאמת בנק שנשאר פתוח שאל את השרת כל 20 שניות כל הלילה; בלשונית מוסתרת בלי סנכרון — לא שואלים.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZReport, getZReport } from '../src/services/zreports.js';

let server, base, db, o, st;
before(async () => {
  db = await freshDb(); o = await owner(db); st = await firstStore(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const post = (path, fields) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

test('adding a Z with two amounts run together: a message naming the field, not an error page; nothing saved', async () => {
  const before = Number((await db.one('SELECT COUNT(*) AS n FROM z_reports', [])).n);
  const r = await post('/reports/zreports', { store_id: String(st.id), ctx_store: String(st.id), z_number: '9001', z_date: '2026-11-08',
    daily_total: '25841.118023.18', drawer_cash: '1000', drawer_credit: '0' });
  assert.notEqual(r.status, 500, 'not the error page');
  const html = await r.text();
  assert.match(html, /סכום לא תקין בשדה &#34;סה&#34;כ \(יומי Z\)&#34;: 25841\.118023\.18|סכום לא תקין בשדה "סה"כ \(יומי Z\)": 25841\.118023\.18/);
  assert.match(html, /<details class="card collapse no-print" id="zr-add" open>/, 'the add form opens on the message');
  assert.equal(Number((await db.one('SELECT COUNT(*) AS n FROM z_reports', [])).n), before, 'nothing was saved');
});

test('every amount field is named: drawer, credit-card brand, cash expense, deposit bag', async () => {
  const base0 = { store_id: String(st.id), ctx_store: String(st.id), z_number: '9002', z_date: '2026-11-08', daily_total: '100', drawer_cash: '100', drawer_credit: '0' };
  for (const [extra, label] of [
    [{ drawer_check: '1.2.3' }, "צ'ק|צ&#39;ק"],
    [{ cc_kal: '12,3.4.5' }, 'הכנסות מאשראי — כ.א.ל'],
    [{ amount: 'abc' }, 'הוצאות במזומן — סכום'],
    [{ dep_bag: '77', dep_amount: '10.555' }, 'סכום הפקדה'],
  ]) {
    const r = await post('/reports/zreports', { ...base0, ...extra });
    assert.notEqual(r.status, 500);
    assert.match(await r.text(), new RegExp(`סכום לא תקין בשדה (&#34;|")(${label})`), label);
  }
});

test('editing a Z: the same message on the edit page, the stored report untouched', async () => {
  const zr = await createZReport({ storeId: st.id, zNumber: '9003', zDate: '2026-11-07', dailyTotal: 500000, drawerCash: 500000 }, o, db);
  const r = await post(`/reports/zreports/${zr.id}`, { store_id: String(st.id), z_number: '9003', z_date: '2026-11-07',
    daily_total: '5000', drawer_cash: '5000.1.2', drawer_credit: '0' });
  assert.notEqual(r.status, 500);
  assert.match(await r.text(), /סכום לא תקין בשדה (&#34;|")מזומן מגירה/);
  assert.equal((await getZReport(zr.id)).drawer_cash, 500000, 'unchanged');
});

test('the browser stops the submit first: marks the field, keeps everything typed', () => {
  const v = readFileSync(new URL('../src/views/reports/_zform.ejs', import.meta.url), 'utf8');
  assert.match(v, /var AMT_RE = \/\^-\?\\d\+\(\\\.\\d\{1,2\}\)\?\$\/;/, 'the same rule as lib/money.js#toAgorot');
  const guard = v.slice(v.indexOf("form.addEventListener('submit'"));
  assert.ok(guard.indexOf('badAmount()') < guard.indexOf('drawerSum() <= 0'), 'checked before anything else');
  assert.match(guard, /e\.preventDefault\(\);\s*bad\.setAttribute\('aria-invalid', 'true'\);/);
  assert.match(guard, /if \(dlg && !dlg\.open\) dlg\.showModal\(\);/, 'a bad expense amount opens its dialog');
});

test('bank-sync status: no polling in a hidden tab without a running sync; back to the tab → poll at once', () => {
  const v = readFileSync(new URL('../src/views/reconciliation/_bankSync.ejs', import.meta.url), 'utf8');
  assert.match(v, /idle = !active && document\.hidden;\s*if \(idle\) return;/);
  assert.match(v, /timer = setTimeout\(poll, active \? 2000 : 20000\);/, 'a running sync still polls every 2s, hidden or not');
  assert.match(v, /addEventListener\('visibilitychange', function \(\) \{\s*if \(!document\.hidden && idle\) \{ idle = false; poll\(\); \}/);
});
