import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createZReport, listZReports, missingZNumbers, addExpense, expensesTotal, deleteExpense } from '../src/services/zreports.js';
import { profitability } from '../src/services/reports.js';
import { toAgorot } from '../src/lib/money.js';

function invoice(db, sup, store, over) {
  return createInvoice(
    {
      supplierId: sup.id,
      storeId: store.id,
      invoiceNumber: over.invoiceNumber,
      invoiceDate: over.invoiceDate,
      amountBeforeVat: over.beforeVat,
      vatAmount: over.vat,
      docType: over.docType || 'tax_invoice',
    },
    secretary(db),
    db,
  ).invoice;
}

test('profitability: net purchases vs sales, gross profit and margin per store, range-filtered', () => {
  const db = freshDb();
  const store = firstStore(db);
  const sup = approveSupplier(createSupplier({ name: 'ספק' }, secretary(db), db).id, owner(db), db);

  // July purchases: 1170 + 585 - 117 (credit) = 1638
  invoice(db, sup, store, { invoiceNumber: 'P1', invoiceDate: '2026-07-03', beforeVat: toAgorot('1000'), vat: toAgorot('170') });
  invoice(db, sup, store, { invoiceNumber: 'P2', invoiceDate: '2026-07-10', beforeVat: toAgorot('500'), vat: toAgorot('85') });
  invoice(db, sup, store, { invoiceNumber: 'C1', invoiceDate: '2026-07-12', beforeVat: toAgorot('100'), vat: toAgorot('17'), docType: 'credit_note' });
  // August invoice must NOT count in July range
  invoice(db, sup, store, { invoiceNumber: 'P3', invoiceDate: '2026-08-02', beforeVat: toAgorot('2000'), vat: toAgorot('340') });

  // July sales (daily Z): 5000 + 3000 = 8000
  createZReport({ storeId: store.id, zNumber: '101', zDate: '2026-07-03', dailyTotal: toAgorot('5000') }, secretary(db), db);
  createZReport({ storeId: store.id, zNumber: '102', zDate: '2026-07-31', dailyTotal: toAgorot('3000') }, secretary(db), db);
  createZReport({ storeId: store.id, zNumber: '103', zDate: '2026-08-01', dailyTotal: toAgorot('9999') }, secretary(db), db); // out of range

  const { stores, totals } = profitability('2026-07-01', '2026-07-31', db);
  const row = stores.find((s) => s.id === store.id);
  assert.equal(row.purchases, toAgorot('1638'));
  assert.equal(row.sales, toAgorot('8000'));
  assert.equal(row.grossProfit, toAgorot('6362')); // 8000 - 1638
  // "רווח מלמעלה" = profit / sales; "רווח מלמטה" = profit / cost
  assert.equal(Number(row.marginPct.toFixed(2)), Number(((6362 / 8000) * 100).toFixed(2)));
  assert.equal(Number(row.markupPct.toFixed(2)), Number(((6362 / 1638) * 100).toFixed(2)));

  // totals aggregate across stores (only this store has data)
  assert.equal(totals.purchases, toAgorot('1638'));
  assert.equal(totals.sales, toAgorot('8000'));
  assert.equal(totals.grossProfit, toAgorot('6362'));
});

test('a store with sales=0 reports null margin (no divide-by-zero)', () => {
  const db = freshDb();
  const { stores } = profitability('2026-01-01', '2026-01-31', db);
  assert.ok(stores.every((s) => s.marginPct === null));
});

test('Z report: drawer total auto-sums, duplicate Z number blocked, sequence gaps detected', () => {
  const db = freshDb();
  const store = firstStore(db);
  const sec = secretary(db);
  const z = createZReport(
    {
      storeId: store.id, zNumber: '201', zDate: '2026-07-01', dailyTotal: toAgorot('1000'),
      drawerCash: toAgorot('600'), drawerCheck: toAgorot('150'), drawerCredit: toAgorot('200'),
      drawerHakafa: toAgorot('40'), drawerVouchers: toAgorot('10'),
    },
    sec,
    db,
  );
  assert.equal(z.drawer_total, toAgorot('1000')); // 600+150+200+40+10
  assert.throws(
    () => createZReport({ storeId: store.id, zNumber: '201', zDate: '2026-07-02', dailyTotal: 100 }, sec, db),
    /כבר קיים/,
  );
  // 202 missing, 203 present -> gap detected
  createZReport({ storeId: store.id, zNumber: '203', zDate: '2026-07-03', dailyTotal: 100 }, sec, db);
  assert.deepEqual(missingZNumbers(store.id, db), [202]);
  assert.equal(listZReports({ storeId: store.id }, db).length, 2);
});

test('Z expenses: add, total, delete', () => {
  const db = freshDb();
  const store = firstStore(db);
  const sec = secretary(db);
  const z = createZReport({ storeId: store.id, zNumber: '301', zDate: '2026-07-01', dailyTotal: toAgorot('1000') }, sec, db);
  addExpense(z.id, { descriptionType: 'advance', employeeName: 'דני', amount: toAgorot('120') }, sec, db);
  const e2 = addExpense(z.id, { descriptionType: 'tara', amount: toAgorot('30') }, sec, db);
  assert.equal(expensesTotal(z.id, db), toAgorot('150'));
  assert.throws(() => addExpense(z.id, { descriptionType: 'tara', amount: -1 }, sec, db), /לא-שלילי/);
  deleteExpense(e2.id, sec, db);
  assert.equal(expensesTotal(z.id, db), toAgorot('120'));
});
