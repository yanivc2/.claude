// בעלים 22/10, דוחות Z ← "רשומות Z אחרונות": "אפשר גם לפי שקית הפקדה" — אחרי חיפוש ה-Z בסגירת Z (·353).
// הטבלה טוענת 30 דוחות; עמודות Z ו"שקית הפקדה" שואלות גם את השרת (th[data-lookup] → GET /reports/zreports-lookup).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createZReport } from '../src/services/zreports.js';
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
  const old = await createZReport({ storeId: st.id, zNumber: '1001', zDate: '2026-01-05', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  await createDeposit({ storeId: st.id, zReportId: old.id, depositDate: '2026-01-05', bagNumber: '216400001', amount: 60000 }, o, db);
  await createDeposit({ storeId: st.id, zReportId: old.id, depositDate: '2026-01-05', bagNumber: '216400002', amount: 40000 }, o, db);
  const oz = await createZReport({ storeId: other.id, zNumber: '7777', zDate: '2026-01-06', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  await createDeposit({ storeId: other.id, zReportId: oz.id, depositDate: '2026-01-06', bagNumber: '216477777', amount: 100000 }, o, db);
  for (let i = 0; i < 31; i++) await createZReport({ storeId: st.id, zNumber: String(2200 + i), zDate: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, dailyTotal: 100000, drawerCash: 100000 }, o, db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const get = async (path) => (await fetch(base + path, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
const rowsOf = (html) => html.match(/<tr data-row-id="\d+">/g) || [];

test('the page loads the recent 30; Z and "שקית הפקדה" ask the server', async () => {
  const html = await get('/reports/zreports');
  assert.doesNotMatch(html, />1001<\/a>/, 'the old report is not among the recent rows');
  assert.match(html, /<th data-lookup="\/reports\/zreports-lookup\?z=">Z<\/th>/);
  assert.match(html, /<th data-lookup="\/reports\/zreports-lookup\?bag=">שקית הפקדה<\/th>/);
});

test('lookup by Z finds an old report — a full row, all its bags in the bag cell', async () => {
  const html = await get('/reports/zreports-lookup?z=1001');
  assert.equal(rowsOf(html).length, 1);
  assert.match(html, />1001<\/a><\/td>/);
  assert.match(html, /<td class="mono">216400001, 216400002<\/td>/, 'a split deposit lists every bag, so the column filter keeps the row');
  assert.match(html, /class="btn btn-secondary small wa-icon-btn"/);
  assert.doesNotMatch(html, /<html|<header/i, 'rows only — no page chrome');
});

test('lookup by bag — any bag of the report, "contains"', async () => {
  for (const q of ['216400002', '216400001', '2164000']) {
    const html = await get(`/reports/zreports-lookup?bag=${q}`);
    assert.equal(rowsOf(html).length, 1, q);
    assert.match(html, />1001<\/a>/, q);
  }
  assert.equal(rowsOf(await get('/reports/zreports-lookup?bag=999999')).length, 0);
  assert.equal((await get('/reports/zreports-lookup')).trim(), '');
});

test('lookup never crosses the active store (Z or bag)', async () => {
  assert.equal(rowsOf(await get('/reports/zreports-lookup?z=7777')).length, 0);
  assert.equal(rowsOf(await get('/reports/zreports-lookup?bag=216477777')).length, 0);
});

test('a restricted Z-reports role may reach the lookup (enforcePageScope prefix list)', () => {
  assert.ok(NAV_ALLOW.nav_zreports.includes('/reports/zreports-lookup'));
});
