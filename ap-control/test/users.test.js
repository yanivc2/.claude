import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary } from './helpers.js';
import {
  listUsers, createUser, updateUser, resetPasswordByOwner, changeOwnPassword, deleteUser,
} from '../src/services/users.js';
import { verifyPassword } from '../src/lib/auth.js';

test('owner can add a user, change permissions, and reset password; secretary cannot', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const sec = await secretary(db);

  await assert.rejects(
    createUser({ name: 'x', username: 'x', role: 'secretary', password: 'Secret12' }, sec, db),
    /בעלים בלבד/,
  );

  const u = await createUser(
    { name: 'רותי', username: 'ruti', email: 'Ruti@Example.com', role: 'secretary', password: 'Start123' },
    ow, db,
  );
  assert.equal(u.role, 'secretary');
  assert.equal(u.email, 'ruti@example.com'); // normalized lower-case

  // promote (add permissions)
  const promoted = await updateUser(u.id, { role: 'owner' }, ow, db);
  assert.equal(promoted.role, 'owner');

  // reset password by owner
  await resetPasswordByOwner(u.id, 'Newpass9', ow, db);
  const row = await db.one('SELECT password_hash FROM users WHERE id = ?', [u.id]);
  assert.ok(verifyPassword('Newpass9', row.password_hash));

  assert.ok((await listUsers(db)).some((x) => x.username === 'ruti'));
});

test('duplicate username rejected; short initial password rejected; bad email rejected', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await createUser({ name: 'a', username: 'dup', role: 'secretary', password: 'Abcdefg1' }, ow, db);
  await assert.rejects(createUser({ name: 'b', username: 'dup', role: 'secretary', password: 'Abcdefg1' }, ow, db), /כבר קיים/);
  await assert.rejects(createUser({ name: 'c', username: 'c', role: 'secretary', password: '123' }, ow, db), /לפחות 8/);
  await assert.rejects(createUser({ name: 'd', username: 'd', role: 'secretary', email: 'nope', password: 'Abcdefg1' }, ow, db), /מייל/);
});

test('cannot demote or delete the last owner; cannot delete self', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await assert.rejects(updateUser(ow.id, { role: 'secretary' }, ow, db), /בעלים אחד/);
  await assert.rejects(deleteUser(ow.id, ow, db), /המשתמש שלך|בעלים אחד/);
});

test('a user can change their own password with the correct current one', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await resetPasswordByOwner(ow.id, 'Current1', ow, db);
  await assert.rejects(changeOwnPassword(ow.id, { current: 'wrong', next: 'Brandnew1', confirm: 'Brandnew1' }, db), /שגויה/);
  await changeOwnPassword(ow.id, { current: 'Current1', next: 'Brandnew1', confirm: 'Brandnew1' }, db);
  const row = await db.one('SELECT password_hash FROM users WHERE id = ?', [ow.id]);
  assert.ok(verifyPassword('Brandnew1', row.password_hash));
});
