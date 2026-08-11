import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eanChecksumOk } from '../src/lib/ean.js';

test('valid check digits across GTIN lengths', () => {
  assert.equal(eanChecksumOk('4006381333931'), true); // EAN-13 (the classic Stabilo example)
  assert.equal(eanChecksumOk('7290000000015'), true); // EAN-13, Israeli 729 prefix
  assert.equal(eanChecksumOk('96385074'), true); // EAN-8
  assert.equal(eanChecksumOk('036000291452'), true); // UPC-A (12)
  assert.equal(eanChecksumOk('00012345678905'), true); // GTIN-14
});

test('a single misread digit fails the checksum', () => {
  assert.equal(eanChecksumOk('4006381333932'), false);
  assert.equal(eanChecksumOk('7290000000011'), false);
  assert.equal(eanChecksumOk('96385075'), false);
});

test('non-GTIN shapes give no verdict (null) — never an error', () => {
  assert.equal(eanChecksumOk('12345'), null); // supplier internal code
  assert.equal(eanChecksumOk('ABC-123'), null);
  assert.equal(eanChecksumOk(''), null);
  assert.equal(eanChecksumOk(null), null);
  assert.equal(eanChecksumOk(undefined), null);
  assert.equal(eanChecksumOk('123456789012345'), null); // 15 digits — not a GTIN
});
