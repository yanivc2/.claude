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

  const alerts = await db.many("SELECT title, body FROM notifications WHERE title LIKE '%חוסר בסגירת קופה%'", []).catch(() => []);
  assert.equal(alerts.length, 1, 'התראה רק על 701 — ‎-50 = חוסר');
  assert.match(`${alerts[0].title} ${alerts[0].body}`, /Z 701/);
});
