// בעלים 22/10, דוחות Z ← "הצהרות הפקדה": "במספר שקית וסכום גם אפשר להציג תוצאה בחיפוש גם אם זה לא מוצג".
// הטבלה טוענת 30 הצהרות; עמודות "מס' שקית" ו"סכום" שואלות גם את השרת (th[data-lookup] → GET /reports/deposits-lookup).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createDeposit } from '../src/services/deposits.js';
import { NAV_ALLOW } from '../src/lib/permissions.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let o, st, server, base, db;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  const other = await db.one('SELECT id FROM stores WHERE id <> ? ORDER BY id LIMIT 1', [st.id]);
  await createDeposit({ storeId: st.id, depositDate: '2026-01-05', bagNumber: '216400001', amount: 2012370 }, o, db);
  await createDeposit({ storeId: other.id, depositDate: '2026-01-06', bagNumber: '216477777', amount: 777700 }, o, db);
  for (let i = 0; i < 31; i++) {
    await createDeposit({ storeId: st.id, depositDate: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, bagNumber: String(216457900 + i), amount: 500000 + i }, o, db);
  }
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const get = async (path) => (await fetch(base + path, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
const rowsOf = (html) => html.match(/<tr data-row-id="\d+">/g) || [];

test('the page loads the recent 30; "מס\' שקית" and "סכום" ask the server', async () => {
  const html = await get('/reports/zreports');
  const card = html.slice(html.indexOf('<h2>הצהרות הפקדה</h2>'), html.indexOf('</table>', html.indexOf('<h2>הצהרות הפקדה</h2>')));
  assert.doesNotMatch(card, /216400001/, 'the old declaration is not among the recent rows');
  assert.match(card, /<th data-lookup="\/reports\/deposits-lookup\?bag=">מס' שקית<\/th>/);
  assert.match(card, /<th class="right" data-lookup="\/reports\/deposits-lookup\?amount=">סכום<\/th>/);
  assert.equal(rowsOf(card).length, 30);
});

test('lookup by bag finds an old declaration — a full row', async () => {
  const html = await get(`/reports/deposits-lookup?bag=${encodeURIComponent('2164000')}`);
  assert.equal(rowsOf(html).length, 1);
  assert.match(html, /<td class="mono">216400001<\/td>/);
  assert.match(html, /action="\/reports\/deposits\/\d+\/delete"/, 'same actions as any row');
  assert.doesNotMatch(html, /<html|<header/i, 'rows only — no page chrome');
});

test('lookup by amount — however it is typed', async () => {
  for (const q of ['20123.70', '20,123.7', '20123', '₪20,123.70']) {
    const html = await get(`/reports/deposits-lookup?amount=${encodeURIComponent(q)}`);
    assert.equal(rowsOf(html).length, 1, q);
    assert.match(html, /216400001/, q);
  }
  assert.equal(rowsOf(await get('/reports/deposits-lookup?amount=abc')).length, 0, 'no digits → nothing, never "everything"');
  assert.equal((await get('/reports/deposits-lookup')).trim(), '');
});

test('lookup never crosses the active store', async () => {
  assert.equal(rowsOf(await get('/reports/deposits-lookup?bag=216477777')).length, 0);
  assert.equal(rowsOf(await get('/reports/deposits-lookup?amount=7777')).length, 0);
});

test('restricted Z-reports role may reach it; the column filter matches amounts without commas/₪', () => {
  assert.ok(NAV_ALLOW.nav_zreports.includes('/reports/deposits-lookup'));
  const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /function bare\(s\) \{ return s\.replace\(\/\[,₪/);
  assert.match(footer, /: hasText\(norm\(td\.textContent\), q\);/);
});
