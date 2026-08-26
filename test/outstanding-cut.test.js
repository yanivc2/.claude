import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { outstandingChecks } from '../src/services/reports.js';
import { toAgorot } from '../src/lib/money.js';

// Two open checks on one account, due in different months → the date/month cut filters by due date.
test('outstanding due-date cut: all vs single-month vs multi-month vs date range', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const sec = await secretary(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);
  const sup = (await approveSupplier((await createSupplier({ name: 'ספק צ' }, sec, db)).id, ow, db)).id;

  const mk = async (num) => (await createInvoice(
    { supplierId: sup, storeId: store.id, invoiceNumber: num, invoiceDate: '2026-07-01',
      amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice', confirm: true }, sec, db,
  )).invoice;

  const augInv = await mk('AUG'); const sepInv = await mk('SEP');
  await createPayment({ bankAccountId: acct.id, checkNumber: 'C-AUG', paymentDate: '2026-08-15', invoiceIds: [augInv.id] }, ow, db);
  await createPayment({ bankAccountId: acct.id, checkNumber: 'C-SEP', paymentDate: '2026-09-15', invoiceIds: [sepInv.id] }, ow, db);

  const total = (cut) => outstandingChecks(null, cut, db).then((r) => r.accounts.find((a) => a.id === acct.id).outstanding_count);

  assert.equal(Number(await total({})), 2);                                   // הכל
  assert.equal(Number(await total({ month: '2026-08' })), 1);                 // single month
  assert.equal(Number(await total({ months: ['2026-08', '2026-09'] })), 2);   // both months
  assert.equal(Number(await total({ months: ['2026-09'] })), 1);              // one month via list
  assert.equal(Number(await total({ from: '2026-09-01', to: '2026-09-30' })), 1); // date range = Sep
  assert.equal(Number(await total({ from: '2026-08-01', to: '2026-08-31' })), 1); // date range = Aug
});
