// בעלים, 17/10 (צילום "רשומות Z אחרונות"): "מזומן מגירה, לא מגירה כללי" — העמודה מציגה את מזומן
// המגירה בלבד (drawer_cash), לא את סה"כ המגירה (drawer_total = מזומן + אשראי + …).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let o, st, server, base, db;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  await db.run(
    `INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, drawer_credit, drawer_total, created_by)
     VALUES (?, '9911', '2026-10-15', 500000, 120000, 380000, 500000, ?)`, [st.id, o.id]);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('"רשומות Z אחרונות": the column is "מזומן מגירה" and shows the drawer cash, not the drawer total', async () => {
  const html = await (await fetch(`${base}/reports/zreports`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
  assert.match(html, /<th class="right">מזומן מגירה<\/th>/);
  const row = html.split('<tr').find((t) => t.includes('>9911<'));
  assert.ok(row.includes('1,200.00'), 'drawer cash ₪1,200');
  assert.ok(!/<td class="right">₪5,000\.00<\/td>\s*<td class="right">₪5,000\.00<\/td>/.test(row), 'not the drawer total next to the daily total');
});
