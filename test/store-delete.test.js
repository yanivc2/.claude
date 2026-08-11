import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createStoreWithAccount, deleteStore } from '../src/services/orgs.js';
import { createSupplier, getSupplierStoreIds } from '../src/services/suppliers.js';

test('owner can delete an empty store; its bank account + supplier links go too', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const seed = await firstStore(x);
  const store = await createStoreWithAccount(
    { companyId: seed.company_id, storeName: 'חנות זמנית', branch: '123', accountNumber: '456789' }, o, x,
  );
  // Assign a supplier to it, to prove the link is cleaned up.
  const sup = await createSupplier({ name: 'ספק', storeIds: [store.id] }, o, x);
  assert.deepEqual(await getSupplierStoreIds(sup.id, x), [store.id]);

  await deleteStore(store.id, o, x);

  assert.equal(await x.one('SELECT id FROM stores WHERE id = ?', [store.id]), undefined);
  assert.equal(await x.one('SELECT id FROM bank_accounts WHERE store_id = ?', [store.id]), undefined);
  assert.deepEqual(await getSupplierStoreIds(sup.id, x), []);
});

test('deleting a store with a Z report is refused', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const seed = await firstStore(x);
  await x.run('INSERT INTO z_reports (store_id, z_number, z_date, drawer_total, created_by) VALUES (?,?,?,?,?)',
    [seed.id, '900', '2026-01-01', 10000, o.id]);
  await assert.rejects(() => deleteStore(seed.id, o, x), /דוחות Z|לא ניתן למחוק/);
});

test('non-owner cannot delete a store', async () => {
  const x = await freshDb();
  const s = await secretary(x);
  const store = await firstStore(x);
  await assert.rejects(() => deleteStore(store.id, s, x), /בעלים בלבד/);
});
