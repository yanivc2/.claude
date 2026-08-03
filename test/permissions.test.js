import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { createUser, getUser } from '../src/services/users.js';
import { userCan, serializePermissions, parsePermissions } from '../src/lib/permissions.js';
import { createSupplier, approveSupplier, blockSupplier } from '../src/services/suppliers.js';

test('userCan: owner has everything; others only granted keys', () => {
  assert.equal(userCan({ role: 'owner' }, 'void_payment'), true);
  assert.equal(userCan({ role: 'secretary', permissions: '["manage_suppliers"]' }, 'manage_suppliers'), true);
  assert.equal(userCan({ role: 'secretary', permissions: '["manage_suppliers"]' }, 'void_payment'), false);
  assert.equal(userCan({ role: 'secretary', permissions: null }, 'settings'), false);
  assert.equal(userCan(null, 'settings'), false);
});

test('serialize/parse permissions filters unknown keys', () => {
  assert.equal(serializePermissions(['settings', 'bogus', 'void_payment']), '["settings","void_payment"]');
  assert.equal(serializePermissions([]), null);
  assert.deepEqual(parsePermissions('["settings","x"]'), ['settings']);
});

test('a "manager" (secretary + granted perms) can manage suppliers; a plain secretary cannot', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const manager = await createUser(
    { name: 'מנהל', username: 'mgr', role: 'secretary', label: 'מנהל', permissions: ['manage_suppliers'], password: 'Pass123' },
    ow, db,
  );
  assert.equal(manager.label, 'מנהל');
  assert.deepEqual(manager.permissions, ['manage_suppliers']);

  const plain = await createUser(
    { name: 'מזכירה', username: 'sec2', role: 'secretary', password: 'Pass123' },
    ow, db,
  );

  const sup = await createSupplier({ name: 'ספק' }, plain, db);
  // manager (granted) can approve; plain secretary cannot
  await approveSupplier(sup.id, await getUser(manager.id, db), db);
  await assert.rejects(blockSupplier(sup.id, await getUser(plain.id, db), null, db), /הרשאת ניהול ספקים/);
});

test('owner role ignores per-key permissions (always full)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const u = await createUser(
    { name: 'x', username: 'ux', role: 'owner', permissions: ['settings'], password: 'Pass123' },
    ow, db,
  );
  assert.equal(u.permissions.length, 0); // owner stored with no per-key perms (has all anyway)
  assert.equal(userCan(u, 'void_payment'), true);
});
