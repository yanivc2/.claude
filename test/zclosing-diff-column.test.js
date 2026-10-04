// סגירת Z — עמודת "חוסר / יתרה" = (נספר + הוצאות) − מגירה, מספר עם סימן. הדוגמה של הבעלים: מגירה
// 1,000, נספר + הוצאות 950 → ‎-50. אותו ביטוי (closingDiff) בעמודה, בשורת הטופס ובהתראה על חוסר.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZClosing, closingDiff } from '../src/services/zclosing.js';

let server, base;
// שורת הסה"כ של טבלת "סגירות אחרונות" — בדף יש עוד tfoot (ספירת מזומן, ותבנית JS של קופה).
const closingsFoot = (html) => { const i = html.indexOf('<th colspan="4">סה"כ'); return i < 0 ? '' : html.slice(i, html.indexOf('</tfoot>', i)); };
before(async () => { server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server && server.close());

test('closingDiff: הדוגמה של הבעלים — מגירה 1,000, נספר+הוצאות 950 → ‎-50', () => {
  assert.equal(closingDiff({ drawerCash: 100000, grandTotal: 95000 }), -5000);
  assert.equal(closingDiff({ drawerCash: 90000, grandTotal: 95000 }), 5000);
  assert.equal(closingDiff({ drawerCash: 95000, grandTotal: 95000 }), 0);
});

test('העמודה בסגירות האחרונות + התראת חוסר באותו כיוון', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const close = (z, drawerCash, hundreds, expense = 0) => createZClosing({
    employeeFirst: 'רות', employeeLast: 'לוי', zNumber: z, drawerCash, storeId: st.id,
    counts: { 100: hundreds }, registers: [],
    expenses: expense ? [{ desc: 'קפה', amount: expense }] : [],
  }, o, db);
  await close('701', 100000, 9, 5000); // מגירה 1,000 · נספר 900 + הוצאות 50 = 950 → ‎-50 חוסר (מעל ₪20 → התראה)
  await close('702', 90000, 9, 5000);  // מגירה 900 · 950 → +50 יתרה
  await close('703', 95000, 9, 5000);  // תואם

  const html = await (await fetch(`${base}/zclosing`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /<th class="right">חוסר \/ יתרה<\/th>/);
  assert.match(html, /dir="ltr">-₪50\.00</);
  assert.match(html, /dir="ltr">\+₪50\.00</);
  assert.match(html, /<span class="badge b-approved">0<\/span>/);
  // שורת סה"כ: ‎-50 + 50 + 0 = 0
  const foot = closingsFoot(html);
  assert.match(foot, /3 סגירות/);
  assert.match(foot, /<span class="badge b-approved">0<\/span>/);

  const alerts = await db.many("SELECT title, body FROM notifications WHERE title LIKE '%חוסר בסגירת קופה%'", []).catch(() => []);
  assert.equal(alerts.length, 1, 'התראה רק על 701 — ‎-50 = חוסר');
  assert.match(`${alerts[0].title} ${alerts[0].body}`, /Z 701/);
});

test('שורת סה"כ חוסר / יתרה — סכום עם סימן', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const close = (z, drawerCash, hundreds) => createZClosing({
    employeeFirst: 'רות', employeeLast: 'לוי', zNumber: z, drawerCash, storeId: st.id, counts: { 100: hundreds }, registers: [], expenses: [],
  }, o, db);
  await close('801', 100000, 9);  // 900 − 1,000 = ‎-100
  await close('802', 100000, 10); // 0
  await close('803', 70000, 9);   // 900 − 700 = +200 → סה"כ +100
  const html = await (await fetch(`${base}/zclosing`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  const foot = closingsFoot(html);
  assert.match(foot, /dir="ltr">\+₪100\.00</);
  // סה"כ לעמודות הכספיות: מגירה 2,700 · נספר 2,800 · הוצאות 0 · סה"כ 2,800
  assert.match(foot, /₪2,700\.00/);
  assert.match(foot, /<strong>₪2,800\.00<\/strong>/);
  const cols = [...foot.matchAll(/<th\b([^>]*)>/g)].reduce((n, m) => n + Number((m[1].match(/colspan="(\d+)"/) || [0, 1])[1]), 0);
  assert.equal(cols, 10, 'כמו הכותרת (בעלים: עם עמודת פעולות)');
});
