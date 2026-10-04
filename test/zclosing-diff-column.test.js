// סגירת Z — עמודת "חוסר / יתרה". הגדרת הבעלים: מגירה גדולה מ"נספר + הוצאות" = יתרה, קטנה = חוסר.
// אותו ביטוי (closingDiff) בעמודה, בשורת הטופס ובהתראה על חוסר — כדי שלא יגידו דברים הפוכים.
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

test('closingDiff: מגירה > נספר+הוצאות = יתרה (+), קטנה = חוסר (−)', () => {
  assert.equal(closingDiff({ drawerCash: 100000, grandTotal: 95000 }), 5000);
  assert.equal(closingDiff({ drawerCash: 90000, grandTotal: 95000 }), -5000);
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
  await close('701', 100000, 9, 5000); // מגירה 1,000 · נספר 900 + הוצאות 50 = 950 → יתרה 50
  await close('702', 90000, 9, 5000);  // מגירה 900 · 950 → חוסר 50 (מעל ₪20 → התראה)
  await close('703', 95000, 9, 5000);  // תואם

  const html = await (await fetch(`${base}/zclosing`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /<th class="right">חוסר \/ יתרה<\/th>/);
  assert.match(html, /יתרה ₪50\.00/);
  assert.match(html, /חוסר ₪50\.00/);
  assert.match(html, /<span class="badge b-approved">תואם<\/span>/);

  const alerts = await db.many("SELECT title, body FROM notifications WHERE title LIKE '%חוסר בסגירת קופה%'", []).catch(() => []);
  assert.equal(alerts.length, 1, 'התראה רק על 702 — חוסר לפי אותה הגדרה');
  assert.match(`${alerts[0].title} ${alerts[0].body}`, /Z 702/);
});
