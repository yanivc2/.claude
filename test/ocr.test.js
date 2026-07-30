import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { runOcrForInvoice, compareToInvoice, getOcr } from '../src/services/ocr.js';
import {
  extractFields,
  parseAmountToAgorot,
  findAmounts,
  findNineDigits,
} from '../src/lib/ocrExtract.js';
import { toAgorot } from '../src/lib/money.js';

const SAMPLE = [
  'חשבונית מס 10025',
  'תאריך: 05/07/2026',
  'ספק: מאפיית הבוקר בע"מ',
  'מספר הקצאה 123456789',
  'סכום לפני מע"מ 1,000.00',
  'מע"מ 170.00',
  'סה"כ לתשלום 1,170.00 ש"ח',
].join('\n');

test('parse/find helpers', () => {
  assert.equal(parseAmountToAgorot('1,170.00'), 117000);
  assert.equal(parseAmountToAgorot('₪ 90.5'), 9050);
  assert.equal(parseAmountToAgorot('abc'), null);
  assert.deepEqual(findAmounts('a 1,000.00 b 170.00 c 1,170.00'), [117000, 100000, 17000]);
  assert.deepEqual(findNineDigits('x 123456789 y 12345 z 987654321'), ['123456789', '987654321']);
});

test('extractFields reads allocation, amounts (VAT not confused with pre-VAT), date, number', () => {
  const e = extractFields(SAMPLE);
  assert.equal(e.allocationNumber, '123456789');
  assert.equal(e.invoiceNumber, '10025');
  assert.equal(e.date, '2026-07-05');
  assert.equal(e.totalAmount, toAgorot('1170'));
  assert.equal(e.vatAmount, toAgorot('170')); // NOT 1000 (the "לפני מע\"מ" amount)
  assert.equal(e.amountBeforeVat, toAgorot('1000'));
});

// build an invoice with an image path, injecting a fake recognizer
function invoiceWithImage(db, over = {}) {
  const sup = createSupplier({ name: 'ספק' }, secretary(db), db);
  return createInvoice(
    {
      supplierId: sup.id,
      storeId: firstStore(db).id,
      invoiceNumber: over.invoiceNumber ?? '10025',
      allocationNumber: over.allocationNumber ?? null,
      invoiceDate: '2026-07-05',
      amountBeforeVat: toAgorot('1000'),
      vatAmount: toAgorot('170'),
      docType: 'tax_invoice',
      imagePath: 'scan.png',
    },
    secretary(db),
    db,
  ).invoice;
}

test('runOcrForInvoice stores result; compare flags a matching total and a missing allocation', async () => {
  const db = freshDb();
  const inv = invoiceWithImage(db); // typed allocation is null
  await runOcrForInvoice(inv.id, secretary(db), { recognize: async () => SAMPLE }, db);

  const stored = getOcr(inv.id, db);
  assert.ok(stored && stored.extracted.allocationNumber === '123456789');

  const cmp = compareToInvoice(inv.id, db);
  const byField = Object.fromEntries(cmp.rows.map((r) => [r.field, r.status]));
  assert.equal(byField.total_amount, 'match'); // 1170 == 1170
  assert.equal(byField.vat_amount, 'match'); // 170 == 170
  assert.equal(byField.invoice_number, 'match'); // 10025
  assert.equal(byField.allocation_number, 'ocr_only'); // typed null, OCR found it
  assert.equal(cmp.hasMismatch, false);
});

test('compare reports a mismatch when the typed allocation differs from OCR', async () => {
  const db = freshDb();
  const inv = invoiceWithImage(db, { allocationNumber: '999999999' });
  await runOcrForInvoice(inv.id, secretary(db), { recognize: async () => SAMPLE }, db);
  const cmp = compareToInvoice(inv.id, db);
  const alloc = cmp.rows.find((r) => r.field === 'allocation_number');
  assert.equal(alloc.status, 'mismatch');
  assert.equal(cmp.hasMismatch, true);
});

test('OCR refuses an invoice with no image or a PDF image', async () => {
  const db = freshDb();
  const sup = createSupplier({ name: 'ספק' }, secretary(db), db);
  const noImg = createInvoice(
    { supplierId: sup.id, storeId: firstStore(db).id, invoiceNumber: 'N', invoiceDate: '2026-07-05', amountBeforeVat: toAgorot('10'), vatAmount: 0, docType: 'tax_invoice' },
    secretary(db),
    db,
  ).invoice;
  await assert.rejects(() => runOcrForInvoice(noImg.id, secretary(db), { recognize: async () => '' }, db), /אין תמונה/);

  const pdf = createInvoice(
    { supplierId: sup.id, storeId: firstStore(db).id, invoiceNumber: 'P', invoiceDate: '2026-07-05', amountBeforeVat: toAgorot('20'), vatAmount: 0, docType: 'tax_invoice', imagePath: 'doc.pdf' },
    secretary(db),
    db,
  ).invoice;
  await assert.rejects(() => runOcrForInvoice(pdf.id, secretary(db), { recognize: async () => '' }, db), /PDF/);
});
