import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSupplierName, matchSupplier, nameSimilarity } from '../src/lib/supplierMatch.js';

const SUPPLIERS = [
  { id: 1, name: 'חשמל ותאורה דרום בע"מ', tax_id: '514-111-222' },
  { id: 2, name: 'מאפיית הבוקר בע"מ', tax_id: null },
  { id: 3, name: 'Acme Foods Ltd.', tax_id: '  515 999 888 ' },
];

test('normalizeSupplierName strips gershayim, בע"מ / ltd and punctuation', () => {
  assert.equal(normalizeSupplierName('מאפיית הבוקר בע"מ'), 'מאפיית הבוקר');
  assert.equal(normalizeSupplierName('מאפיית   הבוקר בע״מ  '), 'מאפיית הבוקר');
  assert.equal(normalizeSupplierName('מאפיית הבוקר בעמ'), 'מאפיית הבוקר');
  assert.equal(normalizeSupplierName('Acme Foods Ltd.'), 'acme foods');
  assert.equal(normalizeSupplierName('ACME FOODS LIMITED'), 'acme foods');
  assert.equal(normalizeSupplierName('  ספק, בע"מ - (ראשי) '), 'ספק ראשי');
  assert.equal(normalizeSupplierName(null), '');
  assert.equal(normalizeSupplierName(''), '');
});

test('tax id wins over a name that points elsewhere', () => {
  // The name is supplier #2, the tax id belongs to #1 — the tax id decides.
  const m = matchSupplier('מאפיית הבוקר', '514111222', SUPPLIERS);
  assert.equal(m.supplier.id, 1);
  assert.equal(m.method, 'tax_id');
  assert.equal(m.score, 1);
});

test('tax id matches through dashes and spaces on either side', () => {
  assert.equal(matchSupplier(null, '514-111-222', SUPPLIERS).supplier.id, 1);
  assert.equal(matchSupplier(null, '515999888', SUPPLIERS).supplier.id, 3);
  assert.equal(matchSupplier('Acme Foods', '515 999 888', SUPPLIERS).method, 'tax_id');
  // An empty/absent tax id never matches an empty stored one.
  const rows = [{ id: 9, name: 'ספק אלמוני', tax_id: '' }];
  assert.equal(matchSupplier('אין קשר בכלל', '', rows), null);
});

test('exact normalized name match scores 1', () => {
  const m = matchSupplier('מאפיית הבוקר בע"מ', null, SUPPLIERS);
  assert.equal(m.supplier.id, 2);
  assert.equal(m.method, 'exact');
  assert.equal(m.score, 1);
});

test('containment matches a longer printed name, scoring 0.9', () => {
  const m = matchSupplier('מאפיית הבוקר סניף חיפה', null, SUPPLIERS);
  assert.equal(m.supplier.id, 2);
  assert.equal(m.method, 'contains');
  assert.equal(m.score, 0.9);
  // Too short to be meaningful — no containment match.
  assert.equal(matchSupplier('מאפ', null, SUPPLIERS), null);
});

test('fuzzy match passes above the threshold and fails below it', () => {
  const typo = matchSupplier('מאפית הבוקר', null, SUPPLIERS); // missing yod
  assert.equal(typo.supplier.id, 2);
  assert.equal(typo.method, 'fuzzy');
  assert.ok(typo.score >= 0.75 && typo.score < 1, `score ${typo.score}`);

  // Shares a word but is a different business — below threshold.
  assert.equal(matchSupplier('מאפיית הערב', null, SUPPLIERS), null);
  assert.equal(matchSupplier('סופרגז אנרגיה', null, SUPPLIERS), null);
});

test('nameSimilarity is symmetric and bounded', () => {
  assert.equal(nameSimilarity('מאפיית הבוקר', 'מאפיית הבוקר'), 1);
  assert.equal(nameSimilarity('', 'מאפיית הבוקר'), 0);
  const a = nameSimilarity('מאפית הבוקר', 'מאפיית הבוקר');
  const b = nameSimilarity('מאפיית הבוקר', 'מאפית הבוקר');
  assert.equal(a, b);
  assert.ok(a > 0 && a < 1);
});

test('no suppliers, no name → null', () => {
  assert.equal(matchSupplier('מאפיית הבוקר', '514111222', []), null);
  assert.equal(matchSupplier('מאפיית הבוקר', '514111222', undefined), null);
  assert.equal(matchSupplier(null, null, SUPPLIERS), null);
  assert.equal(matchSupplier('בע"מ', null, SUPPLIERS), null); // normalizes to ''
});
