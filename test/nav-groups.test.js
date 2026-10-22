// בעלים 22/10: תפריט הצד בקבוצות; "ראשי · בחוץ · מבוטלים" ו"ראשי · מעוקבות" ("לא לרשום הכל כי זה מטעה") כשורה מתחת לפריט, רק כשאחד מהדפים פתוח.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let db, o, st, server, base;
before(async () => {
  db = await freshDb(); o = await owner(db); st = await firstStore(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const nav = async (u, p) => {
  const html = await (await fetch(base + p, { headers: { cookie: `session=${createSession(u.id)}; ap_store=${st.id}` } })).text();
  return html.slice(html.indexOf('<details class="menu navmenu"'), html.indexOf('</details>', html.indexOf('<details class="menu navmenu"')));
};

test('on צ׳קים בחוץ: "מרקורים" is highlighted and its sub-row shows with "בחוץ" active', async () => {
  const m = await nav(o, '/reports/outstanding');
  assert.match(m, /<a href="\/payments" class="active"><span class="mi-ic">💳<\/span>מרקורים<\/a><div class="nav-sub"><a href="\/payments" class="">ראשי<\/a><span class="nav-sub-sep">·<\/span><a href="\/reports\/outstanding" class="active">בחוץ<\/a><span class="nav-sub-sep">·<\/span><a href="\/voided-checks" class="">מבוטלים<\/a><\/div>/);
  assert.doesNotMatch(m, /href="\/tracked-invoices"/, 'the other sub-row stays hidden');
  for (const h of ['ספקים וחשבוניות', 'תשלומים ובנק', 'קופה', 'צוות', 'דוחות']) assert.match(m, new RegExp(`<div class="nav-group">${h}</div>`));
});

test('a user allowed only צ׳קים בחוץ still gets "מרקורים", leading there — and no heading for an empty group', async () => {
  const sec = await secretary(db);
  await db.run(`UPDATE users SET permissions = '["nav_outstanding"]' WHERE id = ?`, [sec.id]);
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [sec.id, st.company_id]).catch(() => {});
  const m = await nav(sec, '/reports/outstanding');
  assert.match(m, /<a href="\/reports\/outstanding" class="active"><span class="mi-ic">💳<\/span>מרקורים<\/a>/);
  assert.doesNotMatch(m, /nav-sub/, 'one allowed page → no sub-row');
  assert.doesNotMatch(m, /<div class="nav-group">קופה<\/div>/);
});

// בעלים 22/10: "כשנכנסים לאפליקציה או לאתר להציג את לוח הבקרה" — חזרה אחרי 30 דקות בלי פעילות → "/".
test('every page carries the "back after a break → dashboard" script; a deep link is not redirected', async () => {
  const html = await (await fetch(`${base}/employees`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
  assert.match(html, /var KEY = 'apLastSeen', AP_IDLE = 30 \* 60 \* 1000/);
  assert.match(html, /nav\.type === 'reload' \|\| nav\.type === 'back_forward'/, 'only a restore/reload is checked on load — not a fresh link');
  assert.match(html, /if \(document\.visibilityState === 'visible'\) home\(\);/);
  assert.match(html, /location\.replace\('\/'\)/);
});
