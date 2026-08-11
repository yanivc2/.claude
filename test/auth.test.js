import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, createSession, readSession } from '../src/lib/auth.js';

test('hashPassword / verifyPassword round-trip; wrong password rejected', () => {
  const hash = hashPassword('s3cret!');
  assert.match(hash, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
  assert.equal(verifyPassword('s3cret!', hash), true);
  assert.equal(verifyPassword('wrong', hash), false);
  assert.equal(verifyPassword('s3cret!', null), false);
  assert.equal(verifyPassword('s3cret!', 'garbage'), false);
});

test('two hashes of the same password differ (random salt) but both verify', () => {
  const a = hashPassword('same');
  const b = hashPassword('same');
  assert.notEqual(a, b);
  assert.ok(verifyPassword('same', a) && verifyPassword('same', b));
});

test('createSession / readSession round-trip; tamper + expiry rejected', () => {
  const now = 1_000_000;
  const token = createSession(42, now);
  assert.equal(readSession(token, now + 1000), 42);
  // expired
  assert.equal(readSession(token, now + 999 * 3600 * 1000), null);
  // tampered signature (flip the last char to a value guaranteed to differ)
  const flipped = token.slice(0, -1) + (token.slice(-1) === 'f' ? '0' : 'f');
  assert.equal(readSession(flipped, now + 1000), null);
  // tampered user id (signature no longer matches)
  const [, exp, sig] = token.split('.');
  assert.equal(readSession(`99.${exp}.${sig}`, now + 1000), null);
  // malformed
  assert.equal(readSession('nonsense', now), null);
  assert.equal(readSession(null, now), null);
});
