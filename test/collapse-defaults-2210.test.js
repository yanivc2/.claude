// בעלים 22/10: (1) "העברות בבנק ללא תיעוד" — "צמצם כברירת מחדל"; (2) סגירת Z — "שברובריקות יתחילו מאותו קו (גבול ימין)".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { setWatchFrom } from '../src/services/transfers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let o, st, server, base, db;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  const acct = await accountForStore(db, st.id);
  await setWatchFrom('2026-01-01', o, db);
  await db.run(`INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, source) VALUES (?, '2026-06-10', -80900, 'העב׳ במקבץ-נט', 'csv')`, [acct.id]);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const get = async (path) => (await fetch(base + path, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();

test('"העברות בבנק ללא תיעוד" starts collapsed, under a key that survives the changing count', async () => {
  const html = await get('/transfers');
  const h2 = html.match(/<h2[^>]*>🔴 העברות בבנק ללא תיעוד \(\d+\)<\/h2>/);
  assert.ok(h2, 'the red rubric renders when an untracked transfer exists');
  assert.match(h2[0], /data-start-collapsed/);
  assert.match(h2[0], /data-ckey="העברות בבנק ללא תיעוד"/);
});

test('the recent-Z rubrics with "ייצוא" start at the card\'s right edge, not centred', async () => {
  const html = await get('/zclosing');
  for (const id of ['zcxExport', 'zclExport']) {
    assert.match(html, new RegExp(`<summary class="sum-start"><span class="sum-export no-print" id="${id}"`));
  }
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  const rule = css.indexOf('main.page .collapse-card > summary.sum-start { justify-content: flex-start !important; }');
  assert.ok(rule > 0, 'flex-start in RTL = the right edge');
  assert.ok(rule > css.indexOf('main.page .collapse-card > summary { justify-content: center !important; }'), 'after the global centring, so it wins');
});
