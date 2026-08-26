import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, listInvoices } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZClosing, matchClosingExpenseToInvoice, unmatchClosingExpense } from '../src/services/zclosing.js';
import { outstandingChecks } from '../src/services/reports.js';
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

test('matching a manual cash expense to an invoice flips it to "שולם במזומן"; unmatch reverts', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const sec = await secretary(db);
  const sup = (await approveSupplier((await createSupplier({ name: 'ספק מ' }, sec, db)).id, ow, db)).id;
  const inv = await mkInvoice(db, store, 'MATCH-1', sup);

  // a register closing with one manual cash expense (no invoice yet)
  await createZClosing(
    { employeeFirst: 'ר', employeeLast: 'ל', storeId: store.id, zNumber: '800', drawerCash: 0,
      counts: { 200: 1 }, expenses: [{ kind: 'manual', payerName: 'מזומן', purpose: 'קניה', amount: 5000 }] },
    ow, db,
  );
  const exp = await db.one("SELECT id FROM z_closing_expenses WHERE description_type = 'manual' ORDER BY id DESC", []);

  // before: unpaid
  let by = Object.fromEntries((await listInvoices({}, db)).map((r) => [r.invoice_number, r]));
  assert.equal(Number(by['MATCH-1'].cash_matches), 0);

  await matchClosingExpenseToInvoice(exp.id, inv.id, ow, null, db);
  by = Object.fromEntries((await listInvoices({}, db)).map((r) => [r.invoice_number, r]));
  assert.ok(by['MATCH-1'].cash_matches > 0); // now "שולם במזומן"
  const linked = await db.one('SELECT invoice_id, description_type FROM z_closing_expenses WHERE id = ?', [exp.id]);
  assert.equal(Number(linked.invoice_id), inv.id);
  assert.equal(linked.description_type, 'invoice');

  await unmatchClosingExpense(exp.id, ow, db);
  by = Object.fromEntries((await listInvoices({}, db)).map((r) => [r.invoice_number, r]));
  assert.equal(Number(by['MATCH-1'].cash_matches), 0); // reverted to "לא שולם"
});

test('matchClosingExpenseToInvoice refuses an out-of-scope expense before mutating', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db); // store 1 → company 2
  const sec = await secretary(db);
  const sup = (await approveSupplier((await createSupplier({ name: 'ספק ס' }, sec, db)).id, ow, db)).id;
  const inv = await mkInvoice(db, store, 'SC-1', sup);
  await createZClosing(
    { employeeFirst: 'ר', employeeLast: 'ל', storeId: store.id, zNumber: '801', drawerCash: 0,
      counts: { 200: 1 }, expenses: [{ kind: 'manual', payerName: 'x', purpose: 'y', amount: 5000 }] },
    ow, db,
  );
  const exp = await db.one("SELECT id FROM z_closing_expenses WHERE description_type = 'manual' ORDER BY id DESC", []);
  // scope excludes company 2 → must throw, and must NOT have linked the expense
  await assert.rejects(() => matchClosingExpenseToInvoice(exp.id, inv.id, ow, [999], db), /הרשאה/);
  const after = await db.one('SELECT invoice_id FROM z_closing_expenses WHERE id = ?', [exp.id]);
  assert.equal(after.invoice_id, null);
});

test('outstandingChecks filters by store (active-store context on the dashboard)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db); // store 1
  const acct = await accountForStore(db, store.id);
  const sec = await secretary(db);
  const sup = (await approveSupplier((await createSupplier({ name: 'ספק ח' }, sec, db)).id, ow, db)).id;
  const inv = await mkInvoice(db, store, 'OC-1', sup);
  await createPayment(
    { bankAccountId: acct.id, checkNumber: '9100', paymentDate: '2026-09-01', invoiceIds: [inv.id] },
    ow, db,
  );

  const here = await outstandingChecks(null, { storeId: store.id }, db);
  assert.ok(here.totalOutstanding > 0); // this store has an outstanding check

  const other = await outstandingChecks(null, { storeId: 999 }, db);
  assert.equal(other.totalOutstanding, 0); // a different store shows nothing
});
