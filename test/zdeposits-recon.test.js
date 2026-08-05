import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import {
  createZReport, replaceExpenses, listExpenses,
  unmatchedCashExpenses, zSequenceStatus,
} from '../src/services/zreports.js';
import { createDeposit, listDeposits } from '../src/services/deposits.js';
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

  const un = await unmatchedCashExpenses(null, 30, db);
  assert.equal(un.length, 1);
  assert.equal(un[0].payer_name, 'רני');
  assert.equal(un[0].z_report_id, z.id);
  assert.equal(un[0].z_number, '300');
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

test('zSequenceStatus reports a gap with the Z before and after it', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  await createZReport({ storeId: store.id, zNumber: '10', zDate: '2026-08-01', drawerCash: 100 }, ow, db);
  // 11 is missing
  await createZReport({ storeId: store.id, zNumber: '12', zDate: '2026-08-03', drawerCash: 100 }, ow, db);

  const status = await zSequenceStatus(null, db);
  assert.equal(status.ok, false);
  const gap = status.gaps.find((g) => g.missing === 11);
  assert.ok(gap);
  assert.equal(gap.before.z_number, '10');
  assert.equal(gap.after.z_number, '12');
});
