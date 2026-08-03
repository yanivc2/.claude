import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { freshDb, owner } from './helpers.js';
import { requestReset, verifyResetToken, completeReset } from '../src/services/passwordReset.js';
import { verifyPassword } from '../src/lib/auth.js';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function insertToken(db, userId, token, expiresAt) {
  await db.run('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)', [userId, sha256(token), expiresAt]);
}

test('requestReset is a neutral no-op when mail is not configured / no email / no user', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await db.run('UPDATE users SET email = ? WHERE id = ?', ['boss@example.com', ow.id]);
  // mail disabled in tests -> not_configured, and no token stored
  const r = await requestReset('boss@example.com', {}, db);
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'not_configured');
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM password_resets', [])).n, 0);

  assert.equal((await requestReset('nobody', {}, db)).reason, 'no_user');
});

test('a valid token resets the password and is single-use', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const token = 'tok_valid_123';
  await insertToken(db, ow.id, token, new Date(Date.now() + 3600_000).toISOString());

  assert.ok(await verifyResetToken(token, db));
  const res = await completeReset(token, 'Freshpass1', db);
  assert.equal(res.ok, true);
  const row = await db.one('SELECT password_hash FROM users WHERE id = ?', [ow.id]);
  assert.ok(verifyPassword('Freshpass1', row.password_hash));

  // token is burned now
  assert.equal(await verifyResetToken(token, db), null);
  assert.equal((await completeReset(token, 'Another1', db)).ok, false);
});

test('expired token is rejected; short password rejected', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await insertToken(db, ow.id, 'expired_tok', new Date(Date.now() - 1000).toISOString());
  assert.equal(await verifyResetToken('expired_tok', db), null);

  await insertToken(db, ow.id, 'short_tok', new Date(Date.now() + 3600_000).toISOString());
  assert.equal((await completeReset('short_tok', '123', db)).reason, 'policy');
});
