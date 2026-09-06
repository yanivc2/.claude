import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import {
  createSupplier, updateSupplier, getSupplier, listSuppliers,
  getSupplierStoreIds, setSupplierStores, deleteSupplier,
} from '../src/services/suppliers.js';

test('supplier can be assigned to one or more stores; names surface in the list', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const st = await firstStore(x);
  // A second store to prove multi-assignment.
  const st2Info = await x.run('INSERT INTO stores (company_id, name) VALUES (?, ?)', [st.company_id, 'חנות ב׳']);
  const st2Id = st2Info.lastInsertRowid;

  const sup = await createSupplier({ name: 'ספק בדיקה', storeIds: [st.id, st2Id] }, o, x);
  assert.equal(sup.stores.length, 2, 'created supplier carries its two stores');

  const ids = await getSupplierStoreIds(sup.id, x);
  assert.deepEqual([...ids].sort((a, b) => a - b), [st.id, st2Id].sort((a, b) => a - b));

  const list = await listSuppliers(null, x);
  const row = list.find((r) => r.id === sup.id);
  assert.ok(row.stores.some((s) => s.name === 'חנות ב׳'), 'store name shows on the list row');

  // Reassign to a single store — replaces, does not append.
  await updateSupplier(sup.id, { name: 'ספק בדיקה', storeIds: [st2Id] }, o, x);
  assert.deepEqual(await getSupplierStoreIds(sup.id, x), [st2Id]);

  // Clearing assignments.
  await setSupplierStores(sup.id, [], x);
  assert.deepEqual(await getSupplierStoreIds(sup.id, x), []);
});

test('editing a supplier without storeIds leaves assignments untouched', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const st = await firstStore(x);
  const sup = await createSupplier({ name: 'ספק', storeIds: [st.id] }, o, x);
  // updateSupplier called with storeIds omitted (null) must not wipe the assignment.
  await updateSupplier(sup.id, { name: 'ספק שונה' }, o, x);
  assert.deepEqual(await getSupplierStoreIds(sup.id, x), [st.id]);
});

test('deleting a supplier removes its store links', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const st = await firstStore(x);
  const sup = await createSupplier({ name: 'ספק למחיקה', storeIds: [st.id] }, o, x);
  await deleteSupplier(sup.id, o, x);
  const rows = await x.many('SELECT * FROM supplier_stores WHERE supplier_id = ?', [sup.id]);
  assert.equal(rows.length, 0);
});

// --- deleting a supplier ------------------------------------------------------------------------

test('a supplier with no invoices can be deleted; one with invoices is refused, not silently kept', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');
  const { createInvoice } = await import('../src/services/invoices.js');
  const { deleteSupplier } = await import('../src/services/suppliers.js');

  const db = await freshDb();
  const ow = await db.one("SELECT * FROM users WHERE role='owner' LIMIT 1", []);
  const store = await db.one('SELECT * FROM stores ORDER BY id LIMIT 1', []);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק למחיקה', 'approved')", []);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק בשימוש', 'approved')", []);
  const spare = await db.one("SELECT * FROM suppliers WHERE name='ספק למחיקה'", []);
  const used = await db.one("SELECT * FROM suppliers WHERE name='ספק בשימוש'", []);

  // Give the used one an invoice, and both a store link (which must not block the delete).
  await db.run('INSERT INTO supplier_stores (supplier_id, store_id) VALUES (?, ?)', [spare.id, store.id]);
  await createInvoice(
    { supplierId: used.id, storeId: store.id, invoiceNumber: 'DEL-1', invoiceDate: '2026-04-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );

  // Unused → gone, and its store links go with it.
  await deleteSupplier(spare.id, ow, db);
  assert.equal(await db.one('SELECT id FROM suppliers WHERE id = ?', [spare.id]), undefined);
  assert.equal((await db.many('SELECT id FROM supplier_stores WHERE supplier_id = ?', [spare.id])).length, 0);

  // Used → refused, with a message that says why and what to do instead.
  await assert.rejects(() => deleteSupplier(used.id, ow, db), /חשבוניות/);
  assert.ok(await db.one('SELECT id FROM suppliers WHERE id = ?', [used.id]), 'the supplier survives');
  assert.ok(await db.one("SELECT id FROM invoices WHERE invoice_number = 'DEL-1'", []), 'its invoice survives');

  // The edit screen offers the action (and the block alternative next to it).
  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const html = await (await fetch(`${base}/suppliers/${used.id}/edit`, {
      headers: { cookie: `session=${createSession(ow.id)}` },
    })).text();
    assert.match(html, /מחיקת ספק/);
    assert.match(html, new RegExp(`action="/suppliers/${used.id}/delete"`));
    assert.match(html, /חסום ספק|בטל חסימה/);
  } finally {
    server.close();
  }
});
