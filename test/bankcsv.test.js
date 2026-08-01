import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { parseCsv } from '../src/lib/csv.js';
import { normalizeBankRows } from '../src/lib/bankCsv.js';
import { decodeBuffer } from '../src/lib/decodeText.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { autoReconcile } from '../src/services/reconciliation.js';
import { toAgorot } from '../src/lib/money.js';

const BANK_CSV = [
  'תאריך,תיאור הפעולה,פרטים,חשבון,אסמכתא,תאריך ערך,חובה,זכות,יתרה לאחר פעולה,',
  '2026-07-26, שיק , ,12 628 432110,31505,2026-07-26,1911.66,,-67905.82,',
  '2026-07-26, אמריקן אקספרס ,  עבור: יניב רום,12 628 432110,26000281,2026-07-26,,46.16,-65994.16,',
  '2026-07-28, העברה לאחר ,לטובת: רונקין,12 628 432110,473018585,2026-07-28,1888.00,,71385.26,',
].join('\n');

test('normalizeBankRows parses the real Bank Hapoalim export (חובה/זכות, אסמכתא=check no.)', () => {
  const rows = normalizeBankRows(parseCsv(BANK_CSV));
  assert.equal(rows.length, 3);
  // check debit -> negative, reference is the check number
  assert.equal(rows[0].amount, -toAgorot('1911.66'));
  assert.equal(rows[0].rawReference, '31505');
  assert.equal(rows[0].txnDate, '2026-07-26');
  assert.equal(rows[0].description, 'שיק');
  // credit -> positive
  assert.equal(rows[1].amount, toAgorot('46.16'));
  // transfer debit -> negative
  assert.equal(rows[2].amount, -toAgorot('1888.00'));
});

test('unescaped quotes inside a field (בע"מ / מע"מ) do not shift columns', () => {
  const csv = [
    'תאריך,תיאור הפעולה,פרטים,חשבון,אסמכתא,תאריך ערך,חובה,זכות,יתרה לאחר פעולה,',
    '2026-07-28, העברה לאחר ,לטובת: רונקין טכנולוגיות בע"מ עבור: נגישות,12 628 432110,473018585,2026-07-28,1888.00,,71385.26,',
  ].join('\n');
  const rows = normalizeBankRows(parseCsv(csv));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -toAgorot('1888.00')); // amount column NOT shifted by the stray quote
  assert.equal(rows[0].txnDate, '2026-07-28');
  assert.equal(rows[0].rawReference, '473018585');
  assert.ok(rows[0].description.includes('בע"מ'));
});

test('simple CSV format still works; blank/summary rows are skipped, not fatal', () => {
  const ok = normalizeBankRows(parseCsv('date,amount,description,reference\n2026-07-01,-100.50,x,7'));
  assert.equal(ok[0].amount, -10050);
  assert.equal(ok[0].rawReference, '7');
  // An empty movement row is skipped (banks emit trailing/summary blanks) rather
  // than aborting the whole import with "שורה 2".
  assert.deepEqual(normalizeBankRows(parseCsv('date,amount\n,,')), []);
});

// Encode an ASCII+Hebrew string to Windows-1255 bytes (the historical default of
// Hebrew Excel/Windows). Hebrew letters occupy 0xE0–0xFA; ASCII is identity.
function toWin1255(str) {
  const HEB0 = 0x05d0; // 'א'
  const bytes = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp >= HEB0 && cp <= 0x05ea) bytes.push(0xe0 + (cp - HEB0));
    else if (cp < 0x80) bytes.push(cp);
    else bytes.push(0x3f); // '?' for anything else — fine for this test
  }
  return Buffer.from(bytes);
}

test('a Windows-1255 (Hebrew ANSI) export is decoded and parsed', () => {
  const csv = ['תאריך,חובה,זכות,אסמכתא', '2026-07-26,1911.66,,31505'].join('\n');
  const rows = normalizeBankRows(parseCsv(decodeBuffer(toWin1255(csv))));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -toAgorot('1911.66'));
  assert.equal(rows[0].rawReference, '31505');
});

test('UTF-8 with a BOM does not break header detection', () => {
  const csv = '﻿' + BANK_CSV;
  const rows = normalizeBankRows(parseCsv(decodeBuffer(Buffer.from(csv, 'utf8'))));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].rawReference, '31505');
});

test('semicolon-delimited CSV (Hebrew Excel default) is parsed', () => {
  const csv = ['תאריך;חובה;זכות;אסמכתא', '2026-07-26;1911.66;;31505'].join('\n');
  const rows = normalizeBankRows(parseCsv(csv));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -toAgorot('1911.66'));
  assert.equal(rows[0].rawReference, '31505');
});

test('leading title/metadata rows before the header are skipped', () => {
  const csv = [
    'עוקב תנועות בחשבון',
    'חשבון: 12-628-432110',
    '',
    'תאריך,תיאור הפעולה,אסמכתא,חובה,זכות',
    '2026-07-26,שיק,31505,1911.66,',
  ].join('\n');
  const rows = normalizeBankRows(parseCsv(csv));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, -toAgorot('1911.66'));
  assert.equal(rows[0].rawReference, '31505');
});

test('single signed-amount column (תאריך + סכום) is parsed', () => {
  const csv = ['תאריך,תיאור,סכום,אסמכתא', '2026-07-26,שיק,-1911.66,31505', '2026-07-27,זיכוי,46.16,26000281'].join('\n');
  const rows = normalizeBankRows(parseCsv(csv));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].amount, -toAgorot('1911.66'));
  assert.equal(rows[1].amount, toAgorot('46.16'));
});

test('amounts with ₪ / spaces / thousands separators are accepted', () => {
  const csv = ['תאריך,חובה,זכות,אסמכתא', '26/07/2026,"₪1,911.66",,31505'].join('\n');
  const rows = normalizeBankRows(parseCsv(csv));
  assert.equal(rows[0].amount, -toAgorot('1911.66'));
  assert.equal(rows[0].txnDate, '2026-07-26');
});

test('balance column (יתרה לאחר פעולה) is captured when present', () => {
  const rows = normalizeBankRows(parseCsv(BANK_CSV));
  assert.equal(rows[0].balanceAfter, -toAgorot('67905.82'));
  assert.equal(rows[1].balanceAfter, -toAgorot('65994.16'));
});

test('a bad simple-format row still errors with the columns it found', () => {
  assert.throws(() => normalizeBankRows(parseCsv('foo,bar\nx,y')), /העמודות שנמצאו/);
});

test('deterministic match by check number wins even against a same-amount ambiguity', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, await owner(db), db);

  // two checks, same amount + close dates -> would be ambiguous by amount alone
  async function issue(num) {
    const { invoice } = await createInvoice(
      { supplierId: sup.id, storeId: st.id, invoiceNumber: `I${num}`, invoiceDate: '2026-07-20', amountBeforeVat: toAgorot('1620'), vatAmount: toAgorot('291.66'), docType: 'tax_invoice', confirm: true, confirmReason: 'test setup' },
      sec,
      db,
    );
    await approveInvoiceForPayment(invoice.id, sec, db);
    return createPayment({ bankAccountId: acct, checkNumber: num, paymentDate: '2026-07-20', invoiceIds: [invoice.id] }, sec, db);
  }
  await issue('31505');
  const other = await issue('31530');

  const rows = normalizeBankRows(parseCsv(BANK_CSV)).filter((r) => r.rawReference === '31505');
  await importTransactions(acct, rows, 'csv', sec, db);

  const res = await autoReconcile(acct, sec, db);
  assert.equal(res.matched, 1); // deterministic despite the same-amount sibling
  const cleared = (await db.many("SELECT check_number FROM payments WHERE status='cleared'", [])).map((r) => r.check_number);
  assert.deepEqual(cleared, ['31505']);
  assert.equal((await db.one('SELECT status FROM payments WHERE id=?', [other.id])).status, 'issued');
});
