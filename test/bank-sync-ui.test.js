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
  assert.match(page, /class="card no-collapse recon-head" id="bank-sync"/, 'no-collapse: שדה הקוד לא יוסתר באקורדיון');
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

// בעלים 18/10: "תעשה רובריקה בהגדרות עם כותרת סנכרון מהבנק. סדר יותר נכון ויותר ברור את החלק העליון שם".
// תשובות: לרובריקה עוברות רק ההגדרות (מצב מחשב המשרד, המפתח, קליטת דוח פדיון), מתחת ל"פעולות בעלים";
// בהתאמת בנק — שורת חשבון, שורת פעולות (סנכרן · ייבוא · תנועה ידנית), שורת "כלים" (ניקוי · בדיקת שיוך).
test('הגדרות ← "סנכרון מהבנק": מצב מחשב המשרד והמפתח, מתחת ל"פעולות בעלים"; התאמת בנק — שורת חשבון, פעולות, כלים', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const settings = await (await fetch(`${base}/settings`, { headers: { cookie: cookieFor(o.id) } })).text();
  const owners = settings.indexOf('פעולות בעלים</h2>');
  const rubric = settings.indexOf('<summary>סנכרון מהבנק</summary>');
  const step1 = settings.indexOf('הקמת חברה חדשה</summary>');
  assert.ok(owners > 0 && rubric > owners && rubric < step1, 'below "פעולות בעלים", first of the rubrics');
  const box = settings.slice(rubric, settings.indexOf('</details>', rubric));
  assert.match(box, /מחשב המשרד \(הפועלים לעסקים\):/);
  assert.match(box, /המפתח שלך במחשב המשרד: <span class="mono">/);
  assert.doesNotMatch(box, /סנכרן עכשיו<\/button>/, 'the sync button stays in התאמת בנק');

  const page = await (await fetch(`${base}/reconciliation`, { headers: { cookie: `${cookieFor(o.id)}; ap_store=3` } })).text();
  const from = page.indexOf('id="bank-sync"');
  const card = page.slice(from, page.indexOf('</div>', page.indexOf('recon-tools', from)) + 6).replace(/<script>[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(card, /המפתח שלך במחשב המשרד|מחשב המשרד מחובר|מחשב המשרד עוד לא התחבר/, 'agent status + key moved to settings');
  assert.doesNotMatch(card, /קובץ פעולות בחשבון מהבנק \(CSV או Excel\)/, 'no explanation text');
  const at = (t) => card.indexOf(t);
  assert.ok(at('class="recon-account"') > 0 && at('class="recon-account"') < at('🔄 סנכרן עכשיו'), 'the account first');
  assert.ok(at('🔄 סנכרן עכשיו') < at('📄 ייבוא CSV / Excel') && at('📄 ייבוא CSV / Excel') < at('➕ הוספת תנועה ידנית'), 'sync · import · manual');
  assert.ok(at('➕ הוספת תנועה ידנית') < at('class="actions recon-tools"'), 'then the tools row');
  const tools = card.slice(at('class="actions recon-tools"'));
  assert.match(tools, /🧹 ניקוי לפי קובץ/);
  assert.match(tools, /🔍 בדיקת שיוך לחשבון/);
});
