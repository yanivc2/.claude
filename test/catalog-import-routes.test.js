import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { listCatalog, catalogStats } from '../src/services/masterCatalog.js';

// The batched catalog import over HTTP. This pair of routes exists because Vercel refuses a
// request body over ~4.5MB before Express runs, so the browser reads the file and posts rows a
// few thousand at a time — see src/public/catalog-upload.js.

let server;
let base;
let db;
const cookies = {};

async function post(path, body, cookie) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
}

const HEADER = ['ברקוד', 'שם', 'מקט', 'יצרן', 'מחיר שופרסל', 'מחיר רמי לוי'];

before(async () => {
  db = await freshDb();
  const ow = await owner(db);
  cookies.owner = `session=${createSession(ow.id)}`;
  const clerk = await db.run(
    "INSERT INTO users (username, name, role, permissions) VALUES ('pkida', 'פקידה', 'secretary', ?)",
    [JSON.stringify(['settings'])],
  );
  cookies.clerk = `session=${createSession(clerk.lastInsertRowid)}`;

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

test('prepare answers with the columns worth sending', async () => {
  const res = await post('/settings/catalog-import/prepare', { header: HEADER }, cookies.owner);
  assert.equal(res.status, 200);
  // Every column here maps to a field, so all six are kept — the point is that the client is told
  // which ones to send rather than guessing, so an unknown column is dropped before the wire.
  assert.deepEqual((await res.json()).keep, [0, 1, 2, 3, 4, 5]);

  const withJunk = await post(
    '/settings/catalog-import/prepare',
    { header: ['ברקוד', 'מדינת ייצור', 'שם', 'מחיר מדף מינ׳'] },
    cookies.owner,
  );
  assert.deepEqual((await withJunk.json()).keep, [0, 2]); // unknown and 'ignore' columns dropped
});

test('prepare rejects a header without ברקוד and שם', async () => {
  const res = await post('/settings/catalog-import/prepare', { header: ['תיאור', 'כמות'] }, cookies.owner);
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /ברקוד/);
});

test('the import routes are owner-only', async () => {
  // A user with the settings permission can open the page but must not load a catalog.
  for (const path of ['/settings/catalog-import/prepare', '/settings/catalog-import/batch']) {
    const res = await post(path, { header: HEADER, rows: [] }, cookies.clerk);
    assert.equal(res.status, 403);
  }
  const anon = await post('/settings/catalog-import/batch', { header: HEADER, rows: [] });
  assert.equal(anon.status, 302); // bounced to /login
});

test('two batches land as one catalog, and a re-send updates instead of duplicating', async () => {
  const batch = (rows) => post('/settings/catalog-import/batch', { header: HEADER, rows, source: 'בדיקה' }, cookies.owner);

  const first = await batch([
    ['7290000042435', 'חלב מפוסטר 1%', 'A1', 'תנובה', '6.90', '6.50'],
    ['7290116930695', 'חלב נטול לקטוז 2%', '', 'תנובה', '9.90', ''],
  ]);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json().then((r) => [r.kept, r.inserted, r.updated]), [2, 2, 0]);

  const second = await batch([
    ['7290004136857', 'גלי פטל 125 גרם', '', 'תנובה', '5.00', '5.40'],
    ['0101810400091', 'ברקוד עם אפס מוביל', '', '', '', ''],
  ]);
  const s = await second.json();
  assert.equal(s.inserted, 2);

  // Same barcode again with a new name: an update, not a second row. That is what makes a
  // half-finished import safe to simply run again.
  const again = await batch([['7290000042435', 'חלב מפוסטר 1% בקרטון', 'A1', 'תנובה', '6.90', '6.50']]);
  assert.deepEqual(await again.json().then((r) => [r.inserted, r.updated]), [0, 1]);

  const stats = await catalogStats(db);
  assert.equal(stats.items, 4);
  const milk = (await listCatalog({ q: '7290000042435' }, db))[0];
  assert.equal(milk.name, 'חלב מפוסטר 1% בקרטון');
  assert.equal(milk.sku, 'A1');
  assert.equal(milk.source_chain, 'בדיקה');
  assert.equal(milk.retail_price, 670); // the median of 6.90 and 6.50, in agorot
});

test('a batch of rows the parser drops is reported, not silently swallowed', async () => {
  const res = await post(
    '/settings/catalog-import/batch',
    {
      header: HEADER,
      rows: [
        ['', 'בלי ברקוד', '', '', '', ''],
        ['12345', 'ברקוד שלא ניתן לתקן', '', '', '', ''],
        ['7290000042435', 'כפילות בתוך המנה', '', '', '', ''],
        ['7290000042435', 'כפילות בתוך המנה', '', '', '', ''],
      ],
      source: 'בדיקה',
    },
    cookies.owner,
  );
  const r = await res.json();
  assert.equal(r.noBarcode, 1);
  assert.equal(r.badBarcode, 1);
  assert.equal(r.duplicate, 1);
  assert.equal(r.kept, 1);
});
