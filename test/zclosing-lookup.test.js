// בעלים 22/10, סגירת Z ← "סגירות אחרונות": "אם אני מקליד מספר של Z אפילו אם הוא ישן ולא מופיע אני רוצה שיופיע בחיפוש".
// הטבלה מציגה 30 אחרונות; הסינון של עמודת Z שואל גם את השרת (th[data-lookup] → GET /zclosing/lookup?z=).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createZClosing } from '../src/services/zclosing.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let o, st, other, server, base, db;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  other = await db.one('SELECT id FROM stores WHERE id <> ? ORDER BY id LIMIT 1', [st.id]);
  const mk = (z, storeId) => createZClosing({ employeeFirst: 'נופר', employeeLast: 'כ', zNumber: String(z), drawerCash: 974160, storeId, counts: {}, registers: [], expenses: [] }, o, db);
  await mk(1001, st.id);                        // the old one — pushed out of the recent 30 below
  await mk(7777, other.id);                     // another store's Z
  for (let i = 0; i < 31; i++) await mk(2200 + i, st.id);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const get = async (path) => (await fetch(base + path, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();

test('the page shows only the recent 30, and its Z column asks the server', async () => {
  const html = await get('/zclosing');
  assert.doesNotMatch(html, />1001</, 'the old closing is not among the recent rows');
  assert.match(html, /<th data-lookup="\/zclosing\/lookup\?z=">Z<\/th>/);
  assert.match(html, /<tr data-row-id="\d+">/, 'page rows carry their id, so a looked-up row is not added twice');
});

test('lookup finds an old Z that the page did not load — as a full table row', async () => {
  const html = await get('/zclosing/lookup?z=1001');
  const rows = html.match(/<tr data-row-id="\d+">/g) || [];
  assert.equal(rows.length, 1);
  assert.match(html, /<td class="mono">1001<\/td>/);
  assert.match(html, /href="\/zclosing\/\d+">ערוך<\/a>/, 'owner gets the same edit/delete as any row');
  assert.doesNotMatch(html, /<html|<header/i, 'rows only — no page chrome');
});

test('lookup is "contains", newest first, and empty without a query', async () => {
  const many = await get('/zclosing/lookup?z=22');
  const zs = [...many.matchAll(/<td class="mono">(\d+)<\/td>/g)].map((m) => m[1]);
  assert.equal(zs.length, 31, 'all 31 matches — more than the 30 the page loads');
  assert.equal(zs[0], '2230');
  assert.equal(zs[30], '2200');
  assert.equal((await get('/zclosing/lookup')).trim(), '');
});

test('lookup never crosses the active store', async () => {
  const html = await get('/zclosing/lookup?z=7777');
  assert.doesNotMatch(html, /<tr/);
});

test('footer: a data-lookup column inserts the returned rows and the filter re-reads rows each time', () => {
  const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /th\.getAttribute\('data-lookup'\)/);
  assert.match(footer, /r\.classList\.add\('lookup-row'\)/);
  assert.match(footer, /dataRows\(table\.tBodies\[0\]\)\.forEach\(function \(r\) \{/, 'filter() covers rows added after load');
  assert.match(footer, /!th\.hasAttribute\('data-lookup'\)/, 'a lookup column stays a text box, never a dropdown');
});
