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
