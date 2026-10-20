// בעלים 20/10: "מונה 'N לטיפול' ליד כל חנות" — ובחר לספור "הפקדות שלא הופקדו". בבורר העליון, ליד שם החנות,
// "(N)"; חנות בלי הפקדה פתוחה — בלי מספר; ושורת הסבר אחרונה ברשימה הפתוחה כשיש מספר כלשהו.
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

test('no pending deposit anywhere → plain names, no legend', async () => {
  const p = await picker();
  assert.doesNotMatch(p, /\(\d+\)<\/option>/);
  assert.doesNotMatch(p, /הפקדות שלא הופקדו/);
});

test('each store shows its own count of declared-not-deposited; a deposited bag does not count', async () => {
  await dep(3, 0); await dep(3, 0); await dep(4, 1);
  const p = await picker();
  const opt = (id) => (p.match(new RegExp(`<option value="${id}"[^>]*>([^<]*)</option>`)) || [])[1];
  assert.match(opt(3), /\(2\)$/, 'two open declarations in store 3');
  assert.doesNotMatch(opt(4), /\(\d+\)/, 'store 4 only has a deposited bag');
  assert.match(p, /<option value="" disabled>\(N\) = הפקדות שלא הופקדו<\/option>/, 'the open list explains the number');
});
