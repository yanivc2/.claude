import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setUserStores } from '../src/lib/scope.js';

// End-to-end (HTTP, no network) checks for the active-store context: banner, the switch endpoint,
// cookie persistence, and the new-invoice store lock.

let server, base, db;
const cookieFor = (u) => `session=${createSession(u.id)}`;
const get = (path, cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

before(async () => {
  db = await freshDb();
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('owner dashboard shows the store banner with a switcher', async () => {
  const res = await get('/', cookieFor(await owner(db)));
  const html = await res.text();
  assert.match(html, /store-banner/);
  assert.match(html, /חנות פעילה/);
  assert.match(html, /action="\/context\/store"/); // multi-store owner → switch form present
});

test('POST /context/store sets the ap_store cookie for an authorized store', async () => {
  const res = await fetch(`${base}/context/store`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieFor(await owner(db)), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ store_id: '3', return_to: '/' }),
  });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('set-cookie') || '', /ap_store=3/);
});

test('new-invoice locks the store field to the active store (readonly, no select)', async () => {
  const cookie = `${cookieFor(await owner(db))}; ap_store=3`;
  const res = await get('/invoices/new', cookie);
  const html = await res.text();
  assert.match(html, /name="store_id"[^>]*value="3"/);        // hidden locked value
  assert.match(html, /נעול לחנות הפעילה/);                      // lock hint
  assert.doesNotMatch(html, /<select name="store_id" required/); // the form's free picker is gone (banner switch is separate)
});

test('a user granted a single store is auto-locked (banner shows locked, no switcher)', async () => {
  const sec = await db.one("SELECT * FROM users WHERE role='secretary' LIMIT 1", []);
  await setUserStores(sec.id, [4], db); // exactly one store
  const res = await get('/', cookieFor(sec));
  const html = await res.text();
  assert.match(html, /נעול לחנות זו/);
  assert.doesNotMatch(html, /action="\/context\/store"/); // no switch form when locked to one store
});
