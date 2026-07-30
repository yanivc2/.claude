import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAgorot, fromAgorot, formatIls } from '../src/lib/money.js';

test('toAgorot parses shekels to integer agorot', () => {
  assert.equal(toAgorot('1000'), 100000);
  assert.equal(toAgorot('19.99'), 1999);
  assert.equal(toAgorot('1,234.56'), 123456);
  assert.equal(toAgorot(''), 0);
  assert.equal(toAgorot('-50.5'), -5050);
});

test('toAgorot rejects malformed input', () => {
  assert.throws(() => toAgorot('abc'));
  assert.throws(() => toAgorot('1.234')); // more than 2 decimals
});

test('fromAgorot / formatIls format correctly', () => {
  assert.equal(fromAgorot(123456), '1,234.56');
  assert.equal(fromAgorot(-5050), '-50.50');
  assert.equal(formatIls(100000), '₪1,000.00');
});

test('round-trip is stable for typical amounts', () => {
  for (const v of ['0.01', '9.99', '1234.5', '100000']) {
    assert.equal(fromAgorot(toAgorot(v)), Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  }
});
