import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, listInvoices } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZClosing } from '../src/services/zclosing.js';
import { toAgorot } from '../src/lib/money.js';

async function mkInvoice(db, store, number, supId) {
  const sec = await secretary(db);
  return (await createInvoice(
    { supplierId: supId, storeId: store.id, invoiceNumber: number, invoiceDate: '2026-08-10',
      amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice', confirm: true },
    sec, db,
  )).invoice;
}

test('listInvoices enriches "שולם": paid-by-check, paid-in-cash (Z match), and unpaid', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);
  const sec = await secretary(db);
  const sup = (await approveSupplier((await createSupplier({ name: 'ספק פ' }, sec, db)).id, ow, db)).id;

  const paidCheck = await mkInvoice(db, store, 'PC-1', sup);
  await createPayment(
    { bankAccountId: acct.id, checkNumber: '5001', paymentDate: '2026-08-12', invoiceIds: [paidCheck.id] },
    ow, db,
  );

  const cashInv = await mkInvoice(db, store, 'CASH-1', sup);
  await createZClosing(
    { employeeFirst: 'א', employeeLast: 'ב', storeId: store.id, zNumber: '700', drawerCash: 0,
      counts: { 200: 1 }, expenses: [{ kind: 'invoice', payerName: 'x', amount: 10000, invoiceId: cashInv.id }] },
    ow, db,
  );

  await mkInvoice(db, store, 'UN-1', sup); // untouched → unpaid

  const rows = await listInvoices({}, db);
  const by = Object.fromEntries(rows.map((r) => [r.invoice_number, r]));

  assert.equal(by['PC-1'].pay_method, 'check');
  assert.equal(by['PC-1'].pay_check_number, '5001');

  assert.equal(by['CASH-1'].pay_method, null);
  assert.ok(by['CASH-1'].cash_matches > 0); // "שולם במזומן"

  assert.equal(by['UN-1'].pay_method, null);
  assert.equal(Number(by['UN-1'].cash_matches), 0); // "לא שולם"
});
