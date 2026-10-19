// בעלים, 19/10 — צילום של "הסגירה נמחקה." ושאלה: "איזה סגירה נמחקה?". אחרי מחיקה השורה איננה, ולכן
// ההודעה והיומן חייבים לומר בעצמם מה נמחק; ויומן שרשם רק מזהה פנימי לא אמר כלום. וגם: ההודעה יורדת
// מהכתובת אחרי שהוצגה — אחרת רענון/חזרה לאפליקציה מציגים "נמחקה" שוב, ימים אחרי.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZClosing } from '../src/services/zclosing.js';

let db, o, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('deleting a closing names it — in the notice and in the audit log', async () => {
  const store = await db.one("SELECT id, name FROM stores WHERE name = 'מידנייט'", []);
  const id = await createZClosing(
    { employeeFirst: 'נועה', employeeLast: 'כהן', zNumber: '4412', drawerCash: 123450, storeId: store.id, counts: {}, registers: [], expenses: [] },
    o, db,
  );
  const res = await fetch(`${base}/zclosing/${id}/delete`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `session=${createSession(o.id)}; ap_store=${store.id}`, 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(res.status, 303);
  const notice = new URLSearchParams(res.headers.get('location').split('?')[1]).get('notice');
  assert.match(notice, /^נמחקה: סגירת Z 4412 · מידנייט · מגירה ₪1,234\.50 · ספר\/ה נועה כהן · נשמרה /);
  const log = await db.one("SELECT details FROM audit_log WHERE action = 'zclosing.delete' ORDER BY id DESC LIMIT 1", []);
  const d = JSON.parse(log.details);
  assert.deepEqual([d.store, d.z_number, d.drawer_cash, d.counted_by], ['מידנייט', '4412', 123450, 'נועה כהן']);
  assert.equal(await db.one('SELECT id FROM z_closings WHERE id = ?', [id]), undefined);
});

test('a result notice is shown once — then it leaves the address bar', () => {
  const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /\['notice', 'err', 'error'\]\.forEach\(function \(k\) \{ if \(q0\.has\(k\)\) \{ q0\.delete\(k\); had = true; \} \}\);/);
  assert.match(footer, /history\.replaceState\(history\.state, '', location\.pathname/);
});
