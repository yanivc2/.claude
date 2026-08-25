import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { createUser, getUser } from '../src/services/users.js';
import { createInviteLink, completeInvite } from '../src/services/passwordReset.js';
import { verifyPassword, passwordPolicyError } from '../src/lib/auth.js';

test('password policy: 6+ chars, upper+lower+digit, letters+digits only', () => {
  assert.equal(passwordPolicyError('Abcd12'), null);        // ok
  assert.ok(passwordPolicyError('Abc1'));                   // too short
  assert.ok(passwordPolicyError('abcd12'));                 // no uppercase
  assert.ok(passwordPolicyError('ABCD12'));                 // no lowercase
  assert.ok(passwordPolicyError('Abcdef'));                 // no digit
  assert.ok(passwordPolicyError('Abc12!'));                 // special char not allowed
});

test('invite link: the user sets their own username + password; token is single-use', async () => {
  const x = await freshDb();
  const o = await owner(x);
  // Owner creates the user (placeholder username + temp password) and generates a self-setup link.
  const u = await createUser({ name: 'דני', username: 'temp1', role: 'secretary', password: 'Temp123' }, o, x);
  const made = await createInviteLink(u.id, { origin: 'http://x' }, x);
  assert.ok(made && made.link.includes('/invite/'), 'link points at /invite/<token>');
  const token = made.link.split('/invite/')[1];

  // A password with a special char is rejected (letters+digits only).
  assert.equal((await completeInvite(token, { username: 'dani', password: 'Ab1!23' }, x)).reason, 'policy');
  // A username already taken by another user is rejected.
  await createUser({ name: 'x', username: 'taken', role: 'secretary', password: 'Temp123' }, o, x);
  assert.equal((await completeInvite(token, { username: 'taken', password: 'Abcd12' }, x)).reason, 'username_taken');

  // Success: username + password set, forced-change cleared.
  assert.equal((await completeInvite(token, { username: 'dani', password: 'Abcd12' }, x)).ok, true);
  assert.equal((await getUser(u.id, x)).username, 'dani');
  const row = await x.one('SELECT password_hash, must_change_password FROM users WHERE id = ?', [u.id]);
  assert.equal(Number(row.must_change_password), 0);
  assert.ok(verifyPassword('Abcd12', row.password_hash), 'the chosen password works');

  // The token is single-use.
  assert.equal((await completeInvite(token, { username: 'dani2', password: 'Abcd12' }, x)).reason, 'invalid');
});
