import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, secretary } from './helpers.js';
import { createSupplier } from '../src/services/suppliers.js';
import {
  learnFromScan,
  hintsFor,
  readiness,
  parseProfile,
  recordScan,
  getProfile,
  setHints,
  READY_STREAK,
} from '../src/services/supplierProfile.js';
import { buildExtractionRequest, SYSTEM_PROMPT } from '../src/ai/claude.js';

// "הסקיל של הספק" — the profile that learns how one supplier's invoice is laid out.
// The fixtures below are shaped like the real Tnuva invoice the owner photographed: a shortened
// barcode in the code column, a separate כ.בודד count, and no allocation number anywhere.

/** One approved Tnuva-shaped scan. `over` corrupts the model's reading to simulate a correction. */
function tnuvaScan(over = {}) {
  return {
    extraction: {
      invoice_number: '626093611',
      allocation_number: '',
      invoice_date: '06/08/2026', // the model returns Israeli format…
      amount_before_vat: 1000, // …and decimal shekels
      vat_amount: 180,
      total_amount: 1180,
      supplier_name: 'תנובה',
      ...over,
    },
    normalized: {
      header: {
        invoiceNumber: '626093611',
        allocationNumber: null,
        invoiceDate: '2026-08-06', // …while the draft holds ISO
        amountBeforeVat: 100000, // …and agorot
        vatAmount: 18000,
        totalAmount: 118000,
        supplierName: 'תנובה',
      },
      lines: [
        { barcode: '42435', unitQuantity: 16, sku: null, packCost: null },
        { barcode: '16930695', unitQuantity: 8, sku: null, packCost: null },
        { barcode: '4136857', unitQuantity: 12, sku: null, packCost: null },
      ],
    },
  };
}

test('a new supplier starts with an empty skill, not a broken one', () => {
  const p = parseProfile(null);
  assert.equal(p.samples, 0);
  assert.equal(readiness(p).state, 'new');
  assert.deepEqual(hintsFor(p), []); // nothing is asserted about a supplier never seen
  assert.equal(parseProfile('{{ not json').samples, 0); // a corrupt column degrades, never throws
});

test('normalizing is not correcting — the same scan twice must count zero corrections', () => {
  // The trap this guards: the model returns 06/08/2026 and shekels, the approved draft holds
  // 2026-08-06 and agorot. Comparing them raw makes the validator's own work look like four
  // human fixes on every single scan, so the streak never grows and the profile fills with
  // instructions about fields nobody touched.
  const p = learnFromScan(null, tnuvaScan(), 'now');
  assert.deepEqual(p.corrections, {});
  assert.equal(p.cleanStreak, 1);
});

test('the layout is learned from the lines themselves', () => {
  let p = null;
  for (let i = 0; i < 3; i++) p = learnFromScan(p, tnuvaScan(), 'now');

  assert.equal(p.samples, 3);
  assert.equal(p.layout.codes.short, 9); // 3 scans × 3 short codes
  assert.equal(p.layout.codes.full, 0);
  assert.deepEqual([p.layout.codes.minLen, p.layout.codes.maxLen], [5, 8]);
  assert.equal(p.layout.allocation, 0);

  const hints = hintsFor(p);
  assert.ok(hints.some((h) => /ברקוד מקוצר \(5-8 ספרות\)/.test(h)), 'the shortened-code rule');
  assert.ok(hints.some((h) => /כ\.בודד/.test(h)), 'the separate singles column');
  assert.ok(hints.some((h) => /אינו מדפיס מספר הקצאה/.test(h)), 'and that it prints no allocation number');
});

test('a supplier printing full barcodes learns the opposite rule', () => {
  const full = () => ({
    extraction: { invoice_number: '1', invoice_date: '01/01/2026', total_amount: 10 },
    normalized: {
      header: { invoiceNumber: '1', invoiceDate: '2026-01-01', totalAmount: 1000, allocationNumber: '123456789' },
      lines: [{ barcode: '7290000042435' }, { barcode: '7290116930695' }, { barcode: '7290004136857' }],
    },
  });
  let p = null;
  for (let i = 0; i < 3; i++) p = learnFromScan(p, full(), 'now');
  assert.equal(p.layout.codes.full, 9);
  assert.equal(p.layout.codes.short, 0);
  const hints = hintsFor(p);
  assert.ok(hints.some((h) => /ברקוד מלא/.test(h)));
  assert.ok(!hints.some((h) => /אינו מדפיס מספר הקצאה/.test(h)), 'it does print one');
});

test('one correction is noise; a repeated one becomes a rule', () => {
  // A single human fix is as likely to be a typo as a real pattern, and a wrong rule travels with
  // every future scan of this supplier — so it takes a repeat to earn its place.
  let p = learnFromScan(null, tnuvaScan({ invoice_number: '626093612' }), 'now');
  assert.equal(p.corrections.invoice_number, 1);
  assert.ok(!hintsFor(p).some((h) => /מספר החשבונית/.test(h)), 'once is not a rule');

  p = learnFromScan(p, tnuvaScan({ invoice_number: '626093610' }), 'now');
  assert.equal(p.corrections.invoice_number, 2);
  assert.ok(hintsFor(p).some((h) => /שים לב במיוחד למספר החשבונית/.test(h)), 'twice is');
});

test('readiness is measured, and a correction resets it', () => {
  let p = null;
  for (let i = 0; i < READY_STREAK; i++) p = learnFromScan(p, tnuvaScan(), 'now');
  assert.equal(readiness(p).state, 'ready');

  p = learnFromScan(p, tnuvaScan({ total_amount: 999 }), 'now'); // a human had to fix the total
  assert.equal(p.cleanStreak, 0);
  assert.equal(readiness(p).state, 'learning');
  assert.match(readiness(p).label, /0\/3/);
});

test('the profile travels in the user message, never in the cached system prompt', async () => {
  // The system prompt carries cache_control:'ephemeral' and must stay byte-identical, or every
  // scan pays a cache miss. Per-supplier text belongs in the user turn.
  const pages = [{ buffer: Buffer.from('x'), contentType: 'image/jpeg' }];
  const plain = buildExtractionRequest(pages);
  const withHints = buildExtractionRequest(pages, { hints: ['עמודת הקוד היא ברקוד מקוצר'] });

  assert.equal(withHints.system[0].text, SYSTEM_PROMPT);
  assert.equal(withHints.system[0].text, plain.system[0].text);
  assert.deepEqual(withHints.system[0].cache_control, { type: 'ephemeral' });

  const text = withHints.messages[0].content.at(-1).text;
  assert.match(text, /עמודת הקוד היא ברקוד מקוצר/);
  assert.ok(text.length > plain.messages[0].content.at(-1).text.length);
  // An empty profile must not change the request at all.
  assert.equal(buildExtractionRequest(pages, { hints: [] }).messages[0].content.at(-1).text,
    plain.messages[0].content.at(-1).text);
});

test('the profile round-trips through the supplier row', async () => {
  const db = await freshDb();
  const sec = await secretary(db);
  const supplier = await createSupplier({ name: 'תנובה בע"מ', taxId: '514123456' }, sec, db);

  assert.equal(readiness(await getProfile(supplier.id, db)).state, 'new');
  for (let i = 0; i < READY_STREAK; i++) await recordScan(supplier.id, tnuvaScan(), 'now', db);

  const stored = await getProfile(supplier.id, db);
  assert.equal(stored.samples, 3);
  assert.equal(readiness(stored).state, 'ready');

  // The owner's own notes are additive: saving them never wipes what was measured.
  await setHints(supplier.id, ['עמודת "כ.בודד" היא השלישית משמאל', '  '], db);
  const after = await getProfile(supplier.id, db);
  assert.deepEqual(after.hints, ['עמודת "כ.בודד" היא השלישית משמאל']);
  assert.equal(after.samples, 3);
  assert.ok(hintsFor(after).includes('עמודת "כ.בודד" היא השלישית משמאל'));

  // A supplier that was never scanned is a no-op, not a crash.
  assert.equal(await recordScan(null, tnuvaScan(), 'now', db), null);
});
