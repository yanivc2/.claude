import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import {
  listRoleTemplates,
  createRoleTemplate,
  updateRoleTemplate,
  deleteRoleTemplate,
} from '../src/services/roleTemplates.js';

test('role templates: create / list / update / delete, with uniqueness and permission filtering', async () => {
  const db = await freshDb();
  const ow = await owner(db);

  assert.equal((await listRoleTemplates(db)).length, 0);

  const id = await createRoleTemplate(
    { name: 'מנהל חשבונות', permissions: ['approve_payment', 'hold_invoice'] },
    ow,
    db,
  );
  let list = await listRoleTemplates(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'מנהל חשבונות');
  assert.deepEqual([...list[0].permissions].sort(), ['approve_payment', 'hold_invoice'].sort());

  // duplicate name rejected
  await assert.rejects(() => createRoleTemplate({ name: 'מנהל חשבונות', permissions: [] }, ow, db), /כבר קיימת/);
  // empty name rejected
  await assert.rejects(() => createRoleTemplate({ name: '   ', permissions: [] }, ow, db), /שם/);

  // update name + permissions
  await updateRoleTemplate(id, { name: 'מנהל', permissions: ['void_payment'] }, ow, db);
  list = await listRoleTemplates(db);
  assert.equal(list[0].name, 'מנהל');
  assert.deepEqual(list[0].permissions, ['void_payment']);

  // unknown permission keys are filtered out
  await updateRoleTemplate(id, { name: 'מנהל', permissions: ['approve_payment', 'not_real'] }, ow, db);
  list = await listRoleTemplates(db);
  assert.deepEqual(list[0].permissions, ['approve_payment']);

  // delete
  await deleteRoleTemplate(id, ow, db);
  assert.equal((await listRoleTemplates(db)).length, 0);
});
