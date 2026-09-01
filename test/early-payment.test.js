import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePaymentTermsDays, earlyPaymentAlerts } from '../src/services/payments.js';

test('parsePaymentTermsDays reads מיידי and שוטף N', () => {
  assert.equal(parsePaymentTermsDays('מיידי'), 0);
  assert.equal(parsePaymentTermsDays('שוטף 30'), 30);
  assert.equal(parsePaymentTermsDays('שוטף 45'), 45);
  assert.equal(parsePaymentTermsDays('שוטף 60, 50% מקדמה'), 60);
  assert.equal(parsePaymentTermsDays(''), null);
  assert.equal(parsePaymentTermsDays(null), null);
  assert.equal(parsePaymentTermsDays('לפי סיכום'), null);
});

test('earlyPaymentAlerts fires only when paid earlier than the terms window', () => {
  const rows = [
    { supplierName: 'ספק א', invoiceNumber: '1', invoiceDate: '2026-01-01', terms: 'שוטף 30' }, // due ~Jan 31
    { supplierName: 'ספק ב', invoiceNumber: '2', invoiceDate: '2026-01-01', terms: 'שוטף 30' },
    { supplierName: 'ספק ג', invoiceNumber: '3', invoiceDate: '2026-01-01', terms: 'מיידי' },
    { supplierName: 'ספק ד', invoiceNumber: '4', invoiceDate: '2026-01-01', terms: null },
  ];
  // Pay all on Jan 10 (9 days after invoice).
  const alerts = earlyPaymentAlerts(rows, '2026-01-10');
  // Only the two שוטף-30 suppliers are early (9 < 30). מיידי (0) and unknown terms never alert.
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((a) => a.supplierName).sort(), ['ספק א', 'ספק ב']);
  assert.equal(alerts[0].earlyDays, 21);
  assert.equal(alerts[0].actualDays, 9);
});

test('paying on/after the terms window does not alert', () => {
  const rows = [{ supplierName: 's', invoiceNumber: '1', invoiceDate: '2026-01-01', terms: 'שוטף 14' }];
  assert.equal(earlyPaymentAlerts(rows, '2026-01-15').length, 0); // 14 days == terms → not early
  assert.equal(earlyPaymentAlerts(rows, '2026-02-01').length, 0); // well after
});

test('the alert is based on the tax invoice, never on a credit note', () => {
  // One supplier, one payment: a tax invoice from Jan 1 plus a credit note from Jan 20.
  // Terms run from the tax invoice (Jan 1), so paying on Jan 10 is 9 days — early by 21.
  const rows = [
    { supplierId: 7, supplierName: 'קוקה קולה', invoiceNumber: 'A1', invoiceDate: '2026-01-01', terms: 'שוטף 30', docType: 'tax_invoice' },
    { supplierId: 7, supplierName: 'קוקה קולה', invoiceNumber: 'Z9', invoiceDate: '2026-01-20', terms: 'שוטף 30', docType: 'credit_note' },
  ];
  const alerts = earlyPaymentAlerts(rows, '2026-01-10');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].invoiceNumber, 'A1');
  assert.equal(alerts[0].actualDays, 9);
  assert.equal(alerts[0].earlyDays, 21);
});

test('a credit note alone never alerts', () => {
  const rows = [
    { supplierId: 7, supplierName: 'קוקה קולה', invoiceNumber: 'Z9', invoiceDate: '2026-01-01', terms: 'שוטף 30', docType: 'credit_note' },
  ];
  assert.equal(earlyPaymentAlerts(rows, '2026-01-10').length, 0);
});

test('several tax invoices of one supplier → the EARLIEST one is the basis, once', () => {
  const rows = [
    { supplierId: 7, supplierName: 'ספק', invoiceNumber: 'B', invoiceDate: '2026-01-20', terms: 'שוטף 30', docType: 'tax_invoice' },
    { supplierId: 7, supplierName: 'ספק', invoiceNumber: 'A', invoiceDate: '2026-01-05', terms: 'שוטף 30', docType: 'tax_invoice_receipt' },
    { supplierId: 7, supplierName: 'ספק', invoiceNumber: 'C', invoiceDate: '2026-01-12', terms: 'שוטף 30', docType: 'tax_invoice' },
    { supplierId: 7, supplierName: 'ספק', invoiceNumber: 'X', invoiceDate: '2026-01-02', terms: 'שוטף 30', docType: 'credit_note' },
  ];
  const alerts = earlyPaymentAlerts(rows, '2026-01-25');
  assert.equal(alerts.length, 1, 'one alert per supplier, not one per invoice');
  assert.equal(alerts[0].invoiceNumber, 'A');
  assert.equal(alerts[0].invoiceDate, '2026-01-05');
  assert.equal(alerts[0].actualDays, 20);
  assert.equal(alerts[0].earlyDays, 10);
});

test('a consolidated payment across a supplier family alerts per supplier', () => {
  // טרה + קוקה קולה on one check: each keeps its own terms clock.
  const rows = [
    { supplierId: 1, supplierName: 'קוקה קולה', invoiceNumber: 'K1', invoiceDate: '2026-01-01', terms: 'שוטף 30', docType: 'tax_invoice' },
    { supplierId: 2, supplierName: 'טרה', invoiceNumber: 'T1', invoiceDate: '2026-01-03', terms: 'שוטף 30', docType: 'tax_invoice' },
    { supplierId: 2, supplierName: 'טרה', invoiceNumber: 'T2', invoiceDate: '2026-01-08', terms: 'שוטף 30', docType: 'tax_invoice' },
  ];
  const alerts = earlyPaymentAlerts(rows, '2026-01-10');
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts.map((a) => a.invoiceNumber).sort(), ['K1', 'T1']);
});
