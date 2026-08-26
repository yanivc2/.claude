import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import {
  createZReport, updateZReport, getZReport, replaceExpenses, listExpenses,
  unmatchedCashExpenses, zSequenceStatus,
} from '../src/services/zreports.js';
import { createZClosing } from '../src/services/zclosing.js';
import { createDeposit, listDeposits, upsertDepositForZ, depositForZ } from '../src/services/deposits.js';
import { reconcileDeposits } from '../src/services/reconciliation.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { toAgorot } from '../src/lib/money.js';

async function anInvoice(db, store, number) {
  const sec = await secretary(db);
  const sup = await approveSupplier((await createSupplier({ name: `ספק ${number}` }, sec, db)).id, await owner(db), db);
  const { invoice } = await createInvoice(
    {
      supplierId: sup.id,
      storeId: store.id,
      invoiceNumber: number,
      invoiceDate: '2026-08-05',
      amountBeforeVat: toAgorot('100'),
      vatAmount: toAgorot('17'),
      docType: 'tax_invoice',
    },
    sec,
    db,
  );
  return invoice;
}

test('cash expense can be matched to an invoice; unmatched ones surface for the dashboard', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const inv = await anInvoice(db, store, 'INV-1');
  const z = await createZReport({ storeId: store.id, zNumber: '300', zDate: '2026-08-05', drawerCash: 50000 }, ow, db);

  await replaceExpenses(z.id, [
    { payerName: 'דני', purpose: 'קפה', amount: 1500, invoiceId: inv.id }, // matched
    { payerName: 'רני', purpose: 'חלב', amount: 800 },                     // unmatched
  ], ow, db);

  const rows = await listExpenses(z.id);
  const matched = rows.find((r) => r.payer_name === 'דני');
  assert.equal(matched.invoice_id, inv.id);
  assert.equal(matched.invoice_number, 'INV-1');

  const un = await unmatchedCashExpenses(null, 30, null, db);
  assert.equal(un.length, 1);
  assert.equal(un[0].payer_name, 'רני');
  assert.equal(un[0].source, 'zreport');
  assert.equal(un[0].ref_id, z.id);
  assert.equal(un[0].z_number, '300');
});

test('register-closing (סגירת Z) cash expenses also surface as unmatched on the dashboard', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const inv = await anInvoice(db, store, 'INV-C');
  const closingId = await createZClosing({
    employeeFirst: 'רון', employeeLast: 'לוי', storeId: store.id, zNumber: '2162',
    drawerCash: 0, counts: { 200: 1 },
    expenses: [
      { kind: 'manual', payerName: 'תיו', purpose: 'ציוד משרדי', amount: 9000 },         // unmatched → surfaces
      { kind: 'invoice', payerName: 'טרטאה', amount: 97900, invoiceId: inv.id },          // matched → hidden
      { kind: 'salary', payerName: 'עובד', amount: 500 },                                 // payroll → hidden
    ],
  }, ow, db);

  const un = await unmatchedCashExpenses(null, 30, null, db);
  const mine = un.filter((r) => r.source === 'zclosing');
  assert.equal(mine.length, 1);                 // only the manual, unmatched line
  assert.equal(mine[0].payer_name, 'תיו');
  assert.equal(mine[0].ref_id, closingId);      // links back to the register closing
  assert.equal(mine[0].z_number, '2162');
});

test('deposit declared on a Z links back to it (שיוך ל-Z)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const z = await createZReport({ storeId: store.id, zNumber: '301', zDate: '2026-08-05', drawerCash: 20000 }, ow, db);
  await createDeposit({ storeId: store.id, zReportId: z.id, depositDate: '2026-08-05', bagNumber: 'BAG-7', amount: 20000 }, ow, db);

  const rows = await listDeposits({ scope: null }, db);
  const d = rows.find((r) => r.bag_number === 'BAG-7');
  assert.equal(d.z_report_id, z.id);
  assert.equal(d.z_number, '301');
  assert.equal(d.recon_diff, null); // not reconciled yet
});

test('reconcileDeposits matches by bag=reference and records יתרה/חוסר', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const sec = await secretary(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);

  await createDeposit({ storeId: store.id, depositDate: '2026-08-05', bagNumber: '555', amount: 100000 }, ow, db);
  // Bank credit whose reference equals the bag number but a slightly higher amount → יתרה of +50.00
  await importTransactions(acct.id, [{ txnDate: '2026-08-06', amount: 105000, description: 'הפקדה', rawReference: '555' }], 'manual', sec, db);

  const res = await reconcileDeposits(acct.id, ow, db);
  assert.equal(res.matched, 1);

  const d = (await listDeposits({ scope: null }, db)).find((r) => r.bag_number === '555');
  assert.equal(d.recon_diff, 5000); // 105000 − 100000
  assert.equal(d.deposited, 1);

  // Running again does not re-match the same deposit/txn.
  assert.equal((await reconcileDeposits(acct.id, ow, db)).matched, 0);
});

test('updateZReport edits fields, recomputes drawer_total and stamps updated_at', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const z = await createZReport({ storeId: store.id, zNumber: '500', zDate: '2026-08-05', dailyTotal: 100000, drawerCash: 100000 }, ow, db);
  assert.equal(z.updated_at, null);

  await updateZReport(z.id, {
    storeId: store.id, zNumber: '500', zDate: '2026-08-05', dailyTotal: 120000,
    drawerCash: 100000, drawerCredit: 50000,
  }, ow, db);

  const after = await getZReport(z.id, db);
  assert.equal(after.daily_total, 120000);
  assert.equal(after.drawer_total, 150000); // 100000 + 50000
  assert.ok(after.updated_at); // stamped
});

test('upsertDepositForZ updates the linked deposit in place (edit form)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const z = await createZReport({ storeId: store.id, zNumber: '501', zDate: '2026-08-05', drawerCash: 10000 }, ow, db);
  await createDeposit({ storeId: store.id, zReportId: z.id, depositDate: '2026-08-05', bagNumber: 'B1', amount: 10000 }, ow, db);

  await upsertDepositForZ(z.id, { storeId: store.id, depositDate: '2026-08-05', bagNumber: 'B1', amount: 22200, deposited: true }, ow, db);
  const d = await depositForZ(z.id, db);
  assert.equal(d.amount, 22200);
  assert.equal(d.deposited, 1);
  // still exactly one deposit for this Z (updated, not duplicated)
  assert.equal((await listDeposits({ scope: null }, db)).filter((r) => r.z_report_id === z.id).length, 1);
});

test('zSequenceStatus reports a gap with the Z before and after it', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  await createZReport({ storeId: store.id, zNumber: '10', zDate: '2026-08-01', drawerCash: 100 }, ow, db);
  // 11 is missing
  await createZReport({ storeId: store.id, zNumber: '12', zDate: '2026-08-03', drawerCash: 100 }, ow, db);

  const status = await zSequenceStatus(null, null, db);
  assert.equal(status.ok, false);
  const gap = status.gaps.find((g) => g.from === 11);
  assert.ok(gap);
  assert.equal(gap.to, 11); // single missing number → from == to
  assert.equal(gap.before.z_number, '10');
  assert.equal(gap.after.z_number, '12');
});

test('zSequenceStatus joins consecutive missing numbers into one range', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  await createZReport({ storeId: store.id, zNumber: '15', zDate: '2026-08-01', drawerCash: 100 }, ow, db);
  // 16..424 missing
  await createZReport({ storeId: store.id, zNumber: '425', zDate: '2026-08-05', drawerCash: 100 }, ow, db);
  const status = await zSequenceStatus(null, null, db);
  assert.equal(status.gaps.length, 1);
  assert.equal(status.gaps[0].from, 16);
  assert.equal(status.gaps[0].to, 424);
  assert.equal(status.gaps[0].before.z_number, '15');
  assert.equal(status.gaps[0].after.z_number, '425');
});

test('matchingClosing links a Z report to its closing by store + Z number; manager breakdown saves', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const { createZClosing, matchingClosing } = await import('../src/services/zclosing.js');
  const { updateZReport, setManagerBreakdown, getZReport } = await import('../src/services/zreports.js');

  const z = await createZReport({ storeId: store.id, zNumber: '900', zDate: '2026-08-06', drawerCash: 100000 }, ow, db);
  await createZClosing({ employeeFirst: 'א', employeeLast: 'ב', storeId: store.id, zNumber: '900', drawerCash: 100000, counts: { '200': 3 }, expenses: [] }, ow, db);

  const match = await matchingClosing(store.id, '900', db);
  assert.ok(match, 'a closing with the same store + Z number is found');
  assert.equal(JSON.parse(match.breakdown)['200'], 3);
  // no match for a different Z number
  assert.ok(!(await matchingClosing(store.id, '901', db)));

  await setManagerBreakdown(z.id, { '200': { count: 2, ok: true } }, ow, db);
  const saved = JSON.parse((await getZReport(z.id, db)).manager_breakdown);
  assert.equal(saved['200'].count, 2);
  assert.equal(saved['200'].ok, true);
});

test('dashboard sources honor the active store: unmatchedCashExpenses + listDeposits filter by storeId', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const stores = await db.many('SELECT id FROM stores ORDER BY id', []);
  const [a, b] = [stores[0].id, stores[1].id];

  // A cash expense + a deposit, both on store A.
  const z = await createZReport({ storeId: a, zNumber: '600', zDate: '2026-08-05', drawerCash: 50000 }, ow, db);
  await replaceExpenses(z.id, [{ payerName: 'מזומן', purpose: 'קניה', amount: 4200 }], ow, db);
  await createDeposit({ storeId: a, depositDate: '2026-08-05', bagNumber: 'BAGA', amount: 5000 }, ow, db);

  // store A sees them
  assert.equal((await unmatchedCashExpenses(null, 30, a, db)).length, 1);
  assert.equal((await listDeposits({ scope: null, storeId: a }, db)).length, 1);
  // store B sees nothing (this was the bug — the dashboard showed another store's data)
  assert.equal((await unmatchedCashExpenses(null, 30, b, db)).length, 0);
  assert.equal((await listDeposits({ scope: null, storeId: b }, db)).length, 0);
});
