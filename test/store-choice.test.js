// "כל החנויות" היא הרשאה (view_all_stores; בעלים תמיד). משתמש עם כמה חנויות ובלי ההרשאה עובד
// תמיד בתוך חנות אחת: בלי חנות פעילה הוא נשלח לבחור, ואינו יכול לנקות את הבחירה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setUserStores } from '../src/lib/scope.js';

let server, base, db, sec;
const cookieFor = (u, store) => `session=${createSession(u.id)}${store ? `; ap_store=${store}` : ''}`;
const get = (path, cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie } });
const post = (path, cookie, body) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

before(async () => {
  db = await freshDb();
  sec = await db.one("SELECT * FROM users WHERE role='secretary' LIMIT 1", []);
  await setUserStores(sec.id, [3, 4], db);
  await db.run("UPDATE users SET permissions = '[]' WHERE id = ?", [sec.id]);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('multi-store user without view_all_stores and no active store → sent to choose one', async () => {
  const r = await get('/invoices?x=1', cookieFor(sec));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `/context/choose?return_to=${encodeURIComponent('/invoices?x=1')}`);
  const page = await get('/context/choose?return_to=%2Finvoices', cookieFor(sec));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal((html.match(/class="store-choose-btn"/g) || []).length, 2, 'one button per granted store');
  assert.match(html, /name="return_to" value="\/invoices"/);
  // the account pages and logout stay reachable without a store
  assert.notEqual((await get('/account/password', cookieFor(sec))).status, 303);
});

test('…with an active store: works normally, and the picker has no "כל החנויות"', async () => {
  const r = await get('/', cookieFor(sec, 3));
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /action="\/context\/store"/);
  assert.doesNotMatch(html, /— כל החנויות —/);
});

test('…clearing the store is ignored (the cookie is not cleared)', async () => {
  const r = await post('/context/store', cookieFor(sec, 3), { store_id: '', return_to: '/' });
  assert.equal(r.status, 303);
  assert.doesNotMatch(r.headers.get('set-cookie') || '', /ap_store=;/);
});

test('owner, and a user granted view_all_stores, keep "כל החנויות"', async () => {
  const o = await owner(db);
  const ho = await (await get('/', cookieFor(o))).text();
  assert.match(ho, /— כל החנויות —/);
  const r = await post('/context/store', cookieFor(o, 3), { store_id: '', return_to: '/' });
  assert.match(r.headers.get('set-cookie') || '', /ap_store=;/);

  await db.run(`UPDATE users SET permissions = '["view_all_stores"]' WHERE id = ?`, [sec.id]);
  const r2 = await get('/', cookieFor(sec));
  assert.equal(r2.status, 200, 'no forced choice with the permission');
  assert.match(await r2.text(), /— כל החנויות —/);
  await db.run("UPDATE users SET permissions = '[]' WHERE id = ?", [sec.id]);
});

test('a single-store user is unaffected (auto-locked, never sent to choose)', async () => {
  await setUserStores(sec.id, [4], db);
  const r = await get('/', cookieFor(sec));
  assert.equal(r.status, 200);
  await setUserStores(sec.id, [3, 4], db);
});
