import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { catalogForSupplier } from '../src/services/supplierCatalog.js';

// Uploading a supplier's own catalog over HTTP. Unlike the קטלוג-על these files are tiny
// (the three real tobacco catalogs are 51-108 rows), so this is one ordinary multipart POST
// with none of the browser-side chunking the big catalog needs.

const CATALOGS = JSON.parse(
  fs.readFileSync(new URL('./fixtures/tobacco-supplier-catalogs.json', import.meta.url), 'utf8'),
);
const GLOBRANDS = 'גלוברנדס בע"מ';

/** The fixture back as a CSV the upload route will parse, headers and all. */
function asCsv(supplier) {
  // The מק"ט header carries a literal double-quote, so in real CSV it must be quoted and the
  // inner quote doubled. Written bare it silently shifts every column after it — see the
  // headerBroken guard in supplierCatalogFile.js.
  const head = 'ברקוד,שם מוצר,"מק""ט",סוג אריזה,יח\' אריזה,מותג,קטגוריה,ברקוד מקושר';
  const rows = CATALOGS[supplier].items.map((i) =>
    [i.barcode, `"${i.name}"`, i.sku ?? '', i.packType ?? '', i.packUnits ?? '', `"${i.brand ?? ''}"`,
      `"${i.category ?? ''}"`, i.linkedBarcode ?? ''].join(','));
  return [head, ...rows].join('\n');
}

let server;
let base;
let db;
let cookie;
let supplierId;

before(async () => {
  db = await freshDb();
  const ow = await owner(db);
  cookie = `session=${createSession(ow.id)}`;
  const ins = await db.run("INSERT INTO suppliers (name, status) VALUES (?, 'approved')", [GLOBRANDS]);
  supplierId = ins.lastInsertRowid;
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

async function upload({ supplier = supplierId, csv = asCsv(GLOBRANDS), name = 'catalog.csv' } = {}) {
  const form = new FormData();
  if (supplier !== null) form.set('supplier_id', String(supplier));
  form.set('catalog', new Blob([csv], { type: 'text/csv' }), name);
  return fetch(`${base}/settings/supplier-catalog-import`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie },
    body: form,
  });
}

test('the owner uploads a supplier catalog and it lands scoped to that supplier', async () => {
  const res = await upload();
  assert.equal(res.status, 303, 'Post/Redirect/Get like every other settings action');

  const rows = await catalogForSupplier(supplierId, db);
  assert.equal(rows.length, 108);
  assert.equal(rows.filter((r) => r.sku).length, 108);
  // The columns the matcher depends on survived the round trip through CSV and SQL.
  const carton = rows.find((r) => r.barcode === '7290121290043');
  assert.equal(carton.pack_type, 'פאקט');
  assert.equal(Number(carton.pack_units), 10);
  assert.equal(carton.name_norm, 'וינסטון כחול בוקס');
});

test('a second upload replaces the supplier catalog rather than doubling it', async () => {
  await upload();
  await upload();
  assert.equal((await catalogForSupplier(supplierId, db)).length, 108);
});

test('an upload with no supplier chosen is refused', async () => {
  const res = await upload({ supplier: null });
  assert.equal(res.status, 200, 'the page re-renders with the error rather than redirecting');
  const body = await res.text();
  assert.match(body, /יש לבחור ספק/);
});

test('a file with the wrong headers is refused with a readable reason', async () => {
  const res = await upload({ csv: 'שם,מחיר\nמרלבורו,30\n' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /ברקוד/);
});

test('a non-owner cannot upload a supplier catalog', async () => {
  const clerk = await db.run(
    "INSERT INTO users (username, name, role, permissions) VALUES ('pk2', 'פקידה', 'secretary', ?)",
    [JSON.stringify(['settings'])],
  );
  const form = new FormData();
  form.set('supplier_id', String(supplierId));
  form.set('catalog', new Blob([asCsv(GLOBRANDS)], { type: 'text/csv' }), 'c.csv');
  const res = await fetch(`${base}/settings/supplier-catalog-import`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: `session=${createSession(clerk.lastInsertRowid)}` },
    body: form,
  });
  assert.notEqual(res.status, 303);
});
