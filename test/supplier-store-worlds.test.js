// בעלים 21/10: "לא רוצה לראות ספקים של חנות אחרת — כל חנות והעולם שלה".
// ספק משויך → רק בחנויות שלו. בלי שיוך → רק בחנויות שיש לו בהן חשבוניות. בלי שתיהן → רק ב"כל החנויות".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createInvoice } from '../src/services/invoices.js';
import { listSuppliers, searchSuppliers, getSupplierStoreIds, effectiveSupplierStoreIds } from '../src/services/suppliers.js';

let db, o, A, B, linkedB, invA, idle, server, base;
const sup = async (name) => (await db.run("INSERT INTO suppliers (name, status) VALUES (?, 'approved')", [name])).lastInsertRowid;
const only = (storeId) => ({ companyIds: null, storeIds: [storeId] });
before(async () => {
  db = await freshDb();
  o = await owner(db);
  [A, B] = (await db.many('SELECT id FROM stores ORDER BY id LIMIT 2', [])).map((r) => r.id);
  await db.run('UPDATE stores SET company_id = (SELECT company_id FROM stores WHERE id = ?) WHERE id = ?', [A, B]);
  linkedB = await sup('ספק משויך ל-B');
  await db.run('INSERT INTO supplier_stores (supplier_id, store_id) VALUES (?, ?)', [linkedB, B]);
  invA = await sup('ספק עם חשבונית ב-A');
  await createInvoice({ supplierId: invA, storeId: A, invoiceNumber: 'W-1', invoiceDate: '2026-10-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' }, o, db);
  idle = await sup('ספק בלי שיוך ובלי חשבוניות');
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('a store sees its linked suppliers and the unlinked ones that invoiced it — nothing of the other store', async () => {
  const ids = async (storeId) => new Set((await listSuppliers(null, db, { scope: only(storeId) })).map((s) => s.id));
  const a = await ids(A);
  const b = await ids(B);
  assert.ok(a.has(invA) && !a.has(linkedB) && !a.has(idle), 'A: only its invoice supplier');
  assert.ok(b.has(linkedB) && !b.has(invA) && !b.has(idle), 'B: only its linked supplier');
  const all = new Set((await listSuppliers(null, db, { scope: { companyIds: null, storeIds: null } })).map((s) => s.id));
  assert.ok(all.has(linkedB) && all.has(invA) && all.has(idle), '"כל החנויות" sees everyone');
  assert.deepEqual((await searchSuppliers('ספק', only(B), db)).map((s) => s.id), [linkedB], 'search obeys the same rule');
  const row = (await listSuppliers(null, db, { scope: only(A) })).find((s) => s.id === invA);
  assert.deepEqual(row.invoiceStores.map((s) => s.id), [A], 'the derived store is exposed for the screen');
  assert.deepEqual(await effectiveSupplierStoreIds(invA, db), [A]);
});

test('a supplier created inside a store belongs to it (not invisible the moment it is saved)', async () => {
  const r = await fetch(`${base}/suppliers`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `session=${createSession(o.id)}; ap_store=${A}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'ספק חדש בחנות A' }).toString(),
  });
  assert.equal(r.status, 303);
  const s = await db.one("SELECT id FROM suppliers WHERE name = 'ספק חדש בחנות A'", []);
  assert.deepEqual(await getSupplierStoreIds(s.id, db), [A]);
  const form = await (await fetch(`${base}/suppliers/new`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${A}` } })).text();
  assert.match(form, new RegExp(`name="store_ids" value="${A}" checked`), 'the new-supplier form pre-ticks the active store');
});

test('the list page shows the derived store dashed, and "לא משויך" for a supplier that belongs nowhere', async () => {
  const html = await (await fetch(`${base}/suppliers`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /class="badge b-neutral sup-store-inv"[^>]*>[^<]+<\/span>/);
  assert.match(html, />לא משויך<\/span>/);
  assert.doesNotMatch(html, /משותף לכל החנויות ולכן מופיע/);
});
