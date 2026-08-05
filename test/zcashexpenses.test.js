import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import {
  createZReport, replaceExpenses, listExpenses, expensesTotal,
  setZReportImage, previousZReport, getZReport, cashReconciliation,
} from '../src/services/zreports.js';

test('cash expenses: bulk replace, empties dropped, total feeds reconciliation', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const z = await createZReport({ storeId: store.id, zNumber: '100', zDate: '2026-08-05', drawerCash: 50000 }, ow, db);

  const n = await replaceExpenses(z.id, [
    { expenseDate: '2026-08-05', payerName: 'דני', purpose: 'קפה', amount: 1500 },
    { expenseDate: '2026-08-05', payerName: '', purpose: 'חלב', amount: 500 },
    { expenseDate: '', payerName: '', purpose: '', amount: 0 }, // empty -> dropped
  ], ow, db);
  assert.equal(n, 2);
  assert.equal((await listExpenses(z.id)).length, 2);
  assert.equal(await expensesTotal(z.id), 2000);

  // a second save REPLACES the previous rows
  await replaceExpenses(z.id, [{ payerName: 'רק אחד', amount: 300 }], ow, db);
  const rows = await listExpenses(z.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].purpose, null);
  assert.equal(await expensesTotal(z.id), 300);

  // reconciliation: drawer cash − deposit − expenses
  const recon = await cashReconciliation(z.id, db);
  assert.equal(recon.expenses, 300);
  assert.equal(recon.diff, 50000 - 0 - 300);

  // a negative amount on a non-empty row is rejected
  await assert.rejects(() => replaceExpenses(z.id, [{ payerName: 'שלילי', amount: -5 }], ow, db), /לא-שלילי/);
});

test('setZReportImage stores the Z-slip scan ref', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const z = await createZReport({ storeId: store.id, zNumber: '101', zDate: '2026-08-05', drawerCash: 10000 }, ow, db);
  await setZReportImage(z.id, 'zslip-101.jpg', ow, db);
  assert.equal((await getZReport(z.id, db)).image_path, 'zslip-101.jpg');
});

test('previousZReport returns the prior Z for the same store', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const z1 = await createZReport({ storeId: store.id, zNumber: '200', zDate: '2026-08-04', drawerCash: 10000 }, ow, db);
  const z2 = await createZReport({ storeId: store.id, zNumber: '201', zDate: '2026-08-05', drawerCash: 10000 }, ow, db);
  const prev = await previousZReport(z2, db);
  assert.ok(prev && prev.id === z1.id);
  assert.equal(await previousZReport(z1, db), undefined); // the earliest has none
});
