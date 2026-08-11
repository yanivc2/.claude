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
