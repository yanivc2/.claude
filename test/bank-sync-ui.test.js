// כרטיס סנכרון הבנק בדף התאמת בנק — הצד של המשתמש.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let server, base;
before(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const cookieFor = (id) => `session=${createSession(id)}`;

test('הכרטיס מופיע בדף, והמצב זמין כ-JSON', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const page = await (await fetch(`${base}/reconciliation`, { headers: { cookie: cookieFor(o.id) } })).text();
  assert.match(page, /id="bank-sync"/);
  assert.match(page, /class="card no-collapse" id="bank-sync"/, 'no-collapse: שדה הקוד לא יוסתר באקורדיון');
  assert.match(page, /סנכרן עכשיו/);

  const st = await fetch(`${base}/reconciliation/bank-sync/status`, { headers: { cookie: cookieFor(o.id), accept: 'application/json' } });
  assert.equal(st.status, 200);
  assert.equal(st.headers.get('cache-control'), 'no-store');
  const j = await st.json();
  assert.equal(j.ready, true);
  assert.equal(j.job, null);
});

// PRG: טופס רגיל (בלי JS) חוזר לדף, לא נשאר על כתובת-פעולה שמקבלת רק POST.
test('בקשה מטופס רגיל → 303 לדף; בקשה מ-fetch → JSON', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const form = await fetch(`${base}/reconciliation/bank-sync/request`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookieFor(o.id), 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(form.status, 303);
  assert.match(form.headers.get('location'), /^\/reconciliation\?notice=/);

  // בקשה שנייה כשאחת פעילה — JSON עם שגיאה ברורה, לא 500.
  const dup = await fetch(`${base}/reconciliation/bank-sync/request`, {
    method: 'POST',
    headers: { cookie: cookieFor(o.id), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.equal(dup.status, 400);
  assert.match((await dup.json()).error, /כבר מתבצע/);
});

// 🔴 סנכרון מתחבר לבנק — מי שלא מורשה לייבא דפי בנק לא יפעיל אותו.
test('משתמש בלי הרשאת import_bank נחסם', async () => {
  const db = await freshDb();
  const r = await db.run(
    `INSERT INTO users (name, role, username, permissions) VALUES ('צופה', 'secretary', 'viewer1', ?)`,
    [JSON.stringify(['nav_reconciliation'])],
  );
  const res = await fetch(`${base}/reconciliation/bank-sync/request`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookieFor(r.lastInsertRowid), accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: '',
  });
  assert.ok([401, 403].includes(res.status), `expected refusal, got ${res.status}`);
  const n = await db.one('SELECT COUNT(*) AS n FROM bank_sync_jobs', []);
  assert.equal(Number(n.n), 0, 'לא נוצרה בקשה');
  const page = await (await fetch(`${base}/reconciliation`, { headers: { cookie: cookieFor(r.lastInsertRowid) } })).text();
  assert.doesNotMatch(page, /id="bank-sync"/, 'והכרטיס לא מוצג לו בכלל');
});
