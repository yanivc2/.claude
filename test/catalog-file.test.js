import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCatalogFile, normalizeBarcode } from '../src/lib/catalogFile.js';

// Header rows cut from the two files the owner actually uploaded — 14 columns and 7 columns,
// same catalog. A fixed column list would have rejected one of them.
const WIDE = "﻿ברקוד,שם,מקט,יח' אריזה,יצרן,כמות,יחידת מידה,שקיל,ארץ ייצור,מחיר מדף,מחיר מדף מינ',מחיר מדף מקס',מספר סניפים,ברקוד תקין";
const NARROW = "﻿ברקוד,שם,מקט,יצרן,יחידת מידה,מחיר מדף,מחיר מדף מינ'";

test('reads the 14-column file', () => {
  const { items, stats } = parseCatalogFile(
    `${WIDE}\n7290016509786,גל כביסה פרסיל 2.5 ליטר,,1,הנקל סוד,2.50,ליטר,,IL,40.90,28.9,42.9,420,כן`,
  );
  assert.equal(stats.kept, 1);
  assert.deepEqual(items[0], {
    barcode: '7290016509786',
    name: 'גל כביסה פרסיל 2.5 ליטר',
    sku: null,
    manufacturerName: 'הנקל סוד',
    unitQty: 'ליטר',
    quantity: 2.5,
    qtyInPackage: 1,
    retailPrice: 4090,
  });
});

test('reads the 7-column file — extra/missing columns are not an error', () => {
  const { items, stats } = parseCatalogFile(
    `${NARROW}\n7290012884986,"ציפס לתנור 1.5 ק""ג",,"תפוגן תעשיות בע""מ",קילוגרם,34.5,22.3`,
  );
  assert.equal(stats.kept, 1);
  assert.equal(items[0].name, 'ציפס לתנור 1.5 ק"ג');
  assert.equal(items[0].manufacturerName, 'תפוגן תעשיות בע"מ');
  assert.equal(items[0].qtyInPackage, null); // column absent — not invented
});

test('a name containing a comma survives quoting', () => {
  const { items } = parseCatalogFile(`${NARROW}\n80773429,"מסטיק מנטוס",,"פרפטי ואן מלה גידה,סאן",גרם,13.9,8.1`);
  assert.equal(items[0].manufacturerName, 'פרפטי ואן מלה גידה,סאן');
});

test('repairs barcodes an Excel round trip stripped leading zeros from', () => {
  // Real damage from a real upload: 1,247 of 38,279 barcodes came back without their zeros.
  // 10 and 11 are not GTIN lengths, and the check digit is what makes the repair safe.
  assert.deepEqual(normalizeBarcode('10181040009'), { barcode: '010181040009', repaired: true });
  assert.deepEqual(normalizeBarcode('7290000042435'), { barcode: '7290000042435', repaired: false });
  const { items, stats } = parseCatalogFile(`${NARROW}\n10181040009,מוצר כלשהו,,יצרן,גרם,10,8`);
  assert.equal(stats.repaired, 1);
  assert.equal(items[0].barcode, '010181040009');
});

test('a code that cannot be repaired is counted, never stored', () => {
  const { items, stats } = parseCatalogFile(`${NARROW}\n12345,מוצר,,יצרן,גרם,10,8`);
  assert.equal(items.length, 0);
  assert.equal(stats.badBarcode, 1);
});

test('rows without a barcode or a name are counted, not stored', () => {
  const { items, stats } = parseCatalogFile(`${NARROW}\n,מוצר בלי ברקוד,,יצרן,גרם,10,8\n7290000042435,,,יצרן,גרם,10,8`);
  assert.equal(items.length, 0);
  assert.equal(stats.noBarcode, 2);
});

test('the first occurrence of a duplicate barcode wins', () => {
  const { items, stats } = parseCatalogFile(
    `${NARROW}\n7290000042435,ראשון,,יצרן,ליטר,6,5\n7290000042435,שני,,יצרן,ליטר,7,6`,
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'ראשון');
  assert.equal(stats.duplicate, 1);
});

test('a file without the required headers is rejected rather than half-read', () => {
  const { items, stats } = parseCatalogFile('code,title\n123,something');
  assert.equal(items.length, 0);
  assert.ok(!stats.columns.includes('barcode'));
});

test('tab-separated files work too', () => {
  const { items } = parseCatalogFile('ברקוד\tשם\tיצרן\n7290000042435\tחלב\tתנובה');
  assert.equal(items[0].barcode, '7290000042435');
  assert.equal(items[0].manufacturerName, 'תנובה');
});
