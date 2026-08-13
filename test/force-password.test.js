import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { createUser, resetPasswordByOwner, changeOwnPassword } from '../src/services/users.js';

test('owner-assigned password sets must_change_password; user changing it clears the flag', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const u = await createUser({ name: 'עובד', username: 'emp1', role: 'secretary', password: 'Initial123' }, o, x);

  // Owner resets/assigns a (temporary) password → must change on next login.
  await resetPasswordByOwner(u.id, 'TempPass99', o, x);
  let row = await x.one('SELECT must_change_password FROM users WHERE id = ?', [u.id]);
  assert.equal(Number(row.must_change_password), 1);

  // The user picks their own password → flag cleared.
  await changeOwnPassword(u.id, { current: 'TempPass99', next: 'MyOwnPass1', confirm: 'MyOwnPass1' }, x);
  row = await x.one('SELECT must_change_password FROM users WHERE id = ?', [u.id]);
  assert.equal(Number(row.must_change_password), 0);
});

test('the seed owner is not forced to change (password set directly, not owner-assigned)', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const row = await x.one('SELECT must_change_password FROM users WHERE id = ?', [o.id]);
  assert.equal(Number(row.must_change_password || 0), 0);
});
