import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createZReport, listZReports, missingZNumbers, addExpense, expensesTotal, deleteExpense, setDeposit, cashReconciliation, setCreditCards, ccReconciliation, zReconciliationStatus } from '../src/services/zreports.js';
import { profitability } from '../src/services/reports.js';
import { toAgorot } from '../src/lib/money.js';

async function invoice(db, sup, store, over) {
  const { invoice: inv } = await createInvoice(
    {
      supplierId: sup.id,
      storeId: store.id,
      invoiceNumber: over.invoiceNumber,
      invoiceDate: over.invoiceDate,
      amountBeforeVat: over.beforeVat,
      vatAmount: over.vat,
      docType: over.docType || 'tax_invoice',
    },
    await secretary(db),
    db,
  );
  return inv;
}

async function getZReportAmount(db, id) {
  return (await db.one('SELECT deposit_amount FROM z_reports WHERE id = ?', [id])).deposit_amount;
}

test('profitability: net purchases vs sales, gross profit and margin per store, range-filtered', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, await owner(db), db);

  await invoice(db, sup, store, { invoiceNumber: 'P1', invoiceDate: '2026-07-03', beforeVat: toAgorot('1000'), vat: toAgorot('170') });
  await invoice(db, sup, store, { invoiceNumber: 'P2', invoiceDate: '2026-07-10', beforeVat: toAgorot('500'), vat: toAgorot('85') });
  await invoice(db, sup, store, { invoiceNumber: 'C1', invoiceDate: '2026-07-12', beforeVat: toAgorot('100'), vat: toAgorot('17'), docType: 'credit_note' });
  await invoice(db, sup, store, { invoiceNumber: 'P3', invoiceDate: '2026-08-02', beforeVat: toAgorot('2000'), vat: toAgorot('340') });

  await createZReport({ storeId: store.id, zNumber: '101', zDate: '2026-07-03', dailyTotal: toAgorot('5000'), drawerCash: toAgorot('5000') }, sec, db);
  await createZReport({ storeId: store.id, zNumber: '102', zDate: '2026-07-31', dailyTotal: toAgorot('3000'), drawerCash: toAgorot('3000') }, sec, db);
  await createZReport({ storeId: store.id, zNumber: '103', zDate: '2026-08-01', dailyTotal: toAgorot('9999'), drawerCash: toAgorot('9999') }, sec, db);

  const { stores, totals } = await profitability('2026-07-01', '2026-07-31', null, db);
  const row = stores.find((s) => s.id === store.id);
  assert.equal(row.purchases, toAgorot('1638'));
  assert.equal(row.sales, toAgorot('8000'));
  assert.equal(row.grossProfit, toAgorot('6362'));
  assert.equal(Number(row.marginPct.toFixed(2)), Number(((6362 / 8000) * 100).toFixed(2)));
  assert.equal(Number(row.markupPct.toFixed(2)), Number(((6362 / 1638) * 100).toFixed(2)));

  assert.equal(totals.purchases, toAgorot('1638'));
  assert.equal(totals.sales, toAgorot('8000'));
  assert.equal(totals.grossProfit, toAgorot('6362'));
});

test('a store with sales=0 reports null margin (no divide-by-zero)', async () => {
  const db = await freshDb();
  const { stores } = await profitability('2026-01-01', '2026-01-31', null, db);
  assert.ok(stores.every((s) => s.marginPct === null));
});

test('Z report: drawer total auto-sums, duplicate Z number blocked, sequence gaps detected', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const z = await createZReport(
    {
      storeId: store.id, zNumber: '201', zDate: '2026-07-01', dailyTotal: toAgorot('1000'),
      drawerCash: toAgorot('600'), drawerCheck: toAgorot('150'), drawerCredit: toAgorot('200'),
      drawerHakafa: toAgorot('40'), drawerVouchers: toAgorot('10'),
    },
    sec,
    db,
  );
  assert.equal(z.drawer_total, toAgorot('1000'));
  await assert.rejects(
    createZReport({ storeId: store.id, zNumber: '201', zDate: '2026-07-02', dailyTotal: 100 }, sec, db),
    /כבר קיים/,
  );
  await createZReport({ storeId: store.id, zNumber: '203', zDate: '2026-07-03', dailyTotal: 100, drawerCash: 100 }, sec, db);
  assert.deepEqual(await missingZNumbers(store.id, db), [202]);
  assert.equal((await listZReports({ storeId: store.id }, db)).length, 2);
});

test('Z expenses: add, total, delete', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const z = await createZReport({ storeId: store.id, zNumber: '301', zDate: '2026-07-01', dailyTotal: toAgorot('1000'), drawerCash: toAgorot('1000') }, sec, db);
  await addExpense(z.id, { descriptionType: 'advance', employeeName: 'דני', amount: toAgorot('120') }, sec, db);
  const e2 = await addExpense(z.id, { descriptionType: 'tara', amount: toAgorot('30') }, sec, db);
  assert.equal(await expensesTotal(z.id, db), toAgorot('150'));
  await assert.rejects(addExpense(z.id, { descriptionType: 'tara', amount: -1 }, sec, db), /לא-שלילי/);
  await deleteExpense(e2.id, sec, db);
  assert.equal(await expensesTotal(z.id, db), toAgorot('120'));
});

test('deposit computes from bill counts; cash reconciliation = drawer cash - deposit - expenses', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const z = await createZReport({ storeId: store.id, zNumber: '401', zDate: '2026-07-01', dailyTotal: toAgorot('2000'), drawerCash: toAgorot('1000') }, sec, db);
  await setDeposit(z.id, { counts: { 200: 4, 100: 1, 0.5: 1 } }, sec, db);
  assert.equal(await getZReportAmount(db, z.id), toAgorot('900.50'));
  await addExpense(z.id, { descriptionType: 'tara', amount: toAgorot('100') }, sec, db);
  const r = await cashReconciliation(z.id, db);
  assert.equal(r.cash, toAgorot('1000'));
  assert.equal(r.deposit, toAgorot('900.50'));
  assert.equal(r.expenses, toAgorot('100'));
  assert.equal(r.diff, toAgorot('1000') - toAgorot('900.50') - toAgorot('100'));
  assert.ok(r.diff < 0);
});

test('credit-card report: brand total + debt-on-credit gap vs אשראי מגירה', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const z = await createZReport({
    storeId: store.id, zNumber: '601', zDate: '2026-07-01', dailyTotal: toAgorot('1000'),
    drawerCredit: toAgorot('1000'),
  }, sec, db);
  const updated = await setCreditCards(z.id, { amounts: {
    kal: toAgorot('300'), isracard: toAgorot('250'), diners: toAgorot('100'),
    amex: toAgorot('100'), general: toAgorot('50'), tourist: 0,
  } }, sec, db);
  assert.equal(updated.cc_total, toAgorot('800'));
  const r = await ccReconciliation(z.id, db);
  assert.equal(r.ccTotal, toAgorot('800'));
  assert.equal(r.drawerCredit, toAgorot('1000'));
  assert.equal(r.debtOnCredit, toAgorot('200'));
  await assert.rejects(setCreditCards(z.id, { amounts: { kal: -1 } }, sec, db), /לא תקין/);
});

test('Z reconciliation status: matched only after data entered; flags cash + cc mismatches', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const z = await createZReport({
    storeId: store.id, zNumber: '701', zDate: '2026-07-01', dailyTotal: toAgorot('1000'),
    drawerCash: toAgorot('1000'), drawerCredit: toAgorot('500'),
  }, sec, db);
  assert.equal((await zReconciliationStatus(z.id, db)).matched, true);
  await setDeposit(z.id, { counts: { 100: 9 } }, sec, db); // 900
  await addExpense(z.id, { descriptionType: 'tara', amount: toAgorot('50') }, sec, db);
  let st = await zReconciliationStatus(z.id, db);
  assert.equal(st.matched, false);
  assert.equal(st.issues.length, 1);
  assert.equal(st.issues[0].type, 'cash');
  await setDeposit(z.id, { counts: { 100: 9, 50: 1 } }, sec, db); // 950
  assert.equal((await zReconciliationStatus(z.id, db)).matched, true);
  await setCreditCards(z.id, { amounts: { kal: toAgorot('600') } }, sec, db);
  st = await zReconciliationStatus(z.id, db);
  assert.equal(st.matched, false);
  assert.ok(st.issues.some((i) => i.type === 'cc'));
});

test('drawer_total sums all five drawer items (סה"כ מגירה)', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const z = await createZReport({
    storeId: store.id, zNumber: '501', zDate: '2026-07-01', dailyTotal: toAgorot('600'),
    drawerCash: toAgorot('300'), drawerCheck: toAgorot('100'), drawerCredit: toAgorot('200'),
    drawerHakafa: toAgorot('50'), drawerVouchers: toAgorot('10'),
  }, sec, db);
  assert.equal(z.drawer_total, toAgorot('660'));
});
