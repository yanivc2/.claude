// בעלים 20/10 הוסיף מונה "(N)" של הפקדות שלא הופקדו ליד כל חנות בבורר העליון; 22/10 — "תוריד" (גם את שורת ההסבר).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let db, o, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const picker = async () => {
  const html = await (await fetch(`${base}/`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=3` } })).text();
  const at = html.indexOf('class="store-banner-pick"');
  return html.slice(at, html.indexOf('</select>', at));
};
const dep = (store, deposited) => db.run(
  'INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, created_by) VALUES (?, ?, ?, ?, ?, ?)',
  [store, '2026-10-19', `B${store}${deposited}${Math.random().toString().slice(2, 7)}`, 10000, deposited, o.id]);

// בעלים 22/10: "תוריד את (1) וגם את המשפט האחרון: (N) = …" — המונה הוסר; נשאר רק שם החנות.
test('pending deposits no longer add a count or a legend to the store picker', async () => {
  await dep(3, 0); await dep(3, 0); await dep(4, 1);
  const p = await picker();
  const opt = (id) => (p.match(new RegExp(`<option value="${id}"[^>]*>([^<]*)</option>`)) || [])[1];
  assert.ok(opt(3), 'store 3 is in the picker');
  assert.doesNotMatch(opt(3), /\(\d+\)/, 'no "(2)" next to the name');
  assert.doesNotMatch(p, /\(\d+\)<\/option>/);
  assert.doesNotMatch(p, /הפקדות שלא הופקדו/, 'no legend line');
});
