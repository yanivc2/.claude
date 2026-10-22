// בעלים 21/10: "← חזרה לדוחות Z" — "שים למעלה משמאל לחזרה"; "📖 מדריך למשתמש" — "לשים מעל לוח הבקרה".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let o, st, zr, server, base, db;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  zr = (await db.run(
    `INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, drawer_credit, drawer_total, created_by)
     VALUES (?, '7701', '2026-10-15', 500000, 120000, 380000, 500000, ?)`, [st.id, o.id])).lastInsertRowid;
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const get = async (p) => (await fetch(base + p, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();

test('Z-report edit: "← חזרה לדוחות Z" sits in the header row (left of "→ חזרה"), not in the page toolbar', async () => {
  const html = await get(`/reports/zreports/${zr}`);
  const start = html.slice(html.indexOf('class="sb-side sb-start"'), html.indexOf('class="sb-center"'));
  assert.match(start, /<a class="btn btn-secondary btn-sm no-print" href="\/reports\/zreports">← חזרה לדוחות Z<\/a>/);
  assert.equal(html.split('חזרה לדוחות Z<').length - 1, 1, 'only once on the page');
});

// בעלים 22/10: "את מדריך למשתמש תוריד למתחת להגדרות" (21/10 היה ראשון).
test('"📖 מדריך למשתמש" sits right under "הגדרות" in the side menu; the settings toolbar no longer has it', async () => {
  const html = await get('/settings');
  const guide = html.indexOf('href="/settings/guide"');
  const settings = html.indexOf('<a href="/settings" ');
  const dash = html.indexOf('<span class="mi-ic">🏠</span>לוח בקרה');
  assert.ok(dash > 0 && settings > dash && guide > settings, 'dashboard … settings, then the guide');
  assert.equal(html.split('href="/settings/guide"').length - 1, 1, 'no second copy in the settings toolbar');
  const onGuide = await get('/settings/guide');
  assert.match(onGuide, /<a href="\/settings\/guide" class="active">/);
  assert.match(onGuide, /<a href="\/settings" class="">/, '"הגדרות" is not highlighted on the guide page');
});
