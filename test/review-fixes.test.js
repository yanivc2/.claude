// Regression tests for the code-review fixes (v104): R3-on-edit, cash-ceiling on a plain payment
// edit, double-void guard, Israel-time clear date, and the reconciliation-badge method column.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, updateInvoice, approveInvoiceForPayment, getInvoice } from '../src/services/invoices.js';
import { createPayment, updatePayment, voidPayment, markCleared } from '../src/services/payments.js';
import { listTransactions, importTransactions } from '../src/services/bankTransactions.js';
import { confirmMatch } from '../src/services/reconciliation.js';
import { assertInScope } from '../src/lib/scopeGuard.js';
import { israelToday } from '../src/lib/loginHours.js';
import { config } from '../src/config.js';

const THRESH = config.rules.allocationThresholdAgorot; // 5,000 ₪ default
const CEIL = config.cashCeilingAgorot; // 6,000 ₪ default

async function base() {
  const db = await freshDb();
  const own = await owner(db);
  const sec = await secretary(db);
  const st = await firstStore(db);
  const acct = await accountForStore(db, st.id);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, own, db);
  return { db, own, sec, st, acct, sup };
}

test('R3: editing a plain tax invoice above the allocation threshold places the R3 hold', async () => {
  const { db, own, sec, st, sup } = await base();
  // Start small (under threshold) with no allocation → plain 'recorded', no hold.
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'E1', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  assert.equal((await getInvoice(invoice.id, db)).status, 'recorded');

  // Edit the amount up over the threshold, still no allocation → must become on_hold (R3).
  await updateInvoice(invoice.id, { amountBeforeVat: THRESH + 100000, vatAmount: 0 }, own, db);
  const held = await getInvoice(invoice.id, db);
  assert.equal(held.status, 'on_hold');
  assert.ok(String(held.hold_reason).startsWith('R3'));
});

test('R3: adding an allocation number on edit clears a stale R3 hold', async () => {
  const { db, own, sec, st, sup } = await base();
  // Over threshold, no allocation → created on_hold (R3).
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'E2', invoiceDate: '2026-07-01', amountBeforeVat: THRESH + 100000, vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  assert.equal((await getInvoice(invoice.id, db)).status, 'on_hold');

  await updateInvoice(invoice.id, { allocationNumber: '123456789' }, own, db);
  assert.equal((await getInvoice(invoice.id, db)).status, 'recorded');
});

test('cash ceiling is enforced on a plain payment edit that switches the method to cash', async () => {
  const { db, own, sec, st, acct, sup } = await base();
  // A check above the cash ceiling (allocation set so R3 does not interfere).
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'P1', allocationNumber: '123456789', invoiceDate: '2026-07-01', amountBeforeVat: CEIL + 100000, vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  await approveInvoiceForPayment(invoice.id, own, db);
  const pay = await createPayment(
    { bankAccountId: acct.id, method: 'check', checkNumber: '7001', paymentDate: '2026-07-02', invoiceIds: [invoice.id] },
    own, db,
  );
  // Plain edit (no invoiceIds) flipping the method to cash must be refused by the ceiling.
  await assert.rejects(
    updatePayment(pay.id, { method: 'cash', payerName: 'יניב', paymentDate: '2026-07-02' }, own, db),
    /חוק צמצום השימוש במזומן/,
  );
});

test('voiding an already-voided payment is refused (idempotency guard)', async () => {
  const { db, own, sec, st, acct, sup } = await base();
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'V1', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  await approveInvoiceForPayment(invoice.id, own, db);
  const pay = await createPayment(
    { bankAccountId: acct.id, method: 'check', checkNumber: '7002', paymentDate: '2026-07-02', invoiceIds: [invoice.id] },
    own, db,
  );
  await voidPayment(pay.id, own, 'טעות', db);
  await assert.rejects(voidPayment(pay.id, own, 'שוב', db), /כבר בוטל/);
});

test('markCleared defaults the cleared date to today in Israel time (not UTC)', async () => {
  const { db, own, sec, st, acct, sup } = await base();
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'C1', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  await approveInvoiceForPayment(invoice.id, own, db);
  const pay = await createPayment(
    { bankAccountId: acct.id, method: 'check', checkNumber: '7003', paymentDate: '2026-07-02', invoiceIds: [invoice.id] },
    own, db,
  );
  const cleared = await markCleared(pay.id, null, own, db);
  assert.equal(cleared.cleared_date, israelToday());
});

test('listTransactions exposes the matched payment method (badge is no longer hard-coded to "צ׳ק")', async () => {
  const { db, own, sec, st, acct, sup } = await base();
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'T1', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  await approveInvoiceForPayment(invoice.id, own, db);
  const pay = await createPayment(
    { bankAccountId: acct.id, method: 'transfer', reference: 'REF-9', paymentDate: '2026-07-02', invoiceIds: [invoice.id] },
    own, db,
  );
  // A matching bank debit (transfer clears as a charge → negative agorot).
  await importTransactions(acct.id, [{ txnDate: '2026-07-02', amount: -10000, description: 'העברה REF-9', rawReference: 'REF-9' }], 'manual', own, db);
  const txn = (await db.many('SELECT id FROM bank_transactions WHERE bank_account_id = ?', [acct.id]))[0];
  await confirmMatch(txn.id, pay.id, own, db);

  const rows = await listTransactions(acct.id, db);
  const matched = rows.find((r) => r.matched_payment_id === pay.id);
  assert.equal(matched.matched_method, 'transfer');
});

test('double-payment guard: the status-conditional UPDATE is a no-op once an invoice is paid (both dialects)', async () => {
  const { db, own, sec, st, acct, sup } = await base();
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'D1', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  await approveInvoiceForPayment(invoice.id, own, db);
  await createPayment(
    { bankAccountId: acct.id, method: 'check', checkNumber: '8001', paymentDate: '2026-07-02', invoiceIds: [invoice.id] },
    own, db,
  );
  assert.equal((await getInvoice(invoice.id, db)).status, 'paid');

  // The guard createPayment relies on: flipping a NON-payable invoice to 'paid' changes 0 rows.
  // That 0-row result is what makes a racing second payment abort instead of double-paying.
  const r = await db.run(
    "UPDATE invoices SET status = 'paid' WHERE id = ? AND status IN ('recorded', 'approved_for_payment')",
    [invoice.id],
  );
  assert.equal(r.changes, 0);

  // And a plain second payment on the same invoice is refused (upstream status check).
  await assert.rejects(
    createPayment(
      { bankAccountId: acct.id, method: 'check', checkNumber: '8002', paymentDate: '2026-07-02', invoiceIds: [invoice.id] },
      own, db,
    ),
  );
});

test('scopeGuard resolves bankAccount and bankTxn company for the reconciliation IDOR guards', async () => {
  const { db, own, sec, st, acct, sup } = await base();
  const companyId = (await db.one('SELECT company_id FROM bank_accounts WHERE id = ?', [acct.id])).company_id;
  // Owner scope (null) always passes and returns the owning company id.
  assert.equal(await assertInScope('bankAccount', acct.id, null, db), companyId);

  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'S1', invoiceDate: '2026-07-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  await approveInvoiceForPayment(invoice.id, own, db);
  const pay = await createPayment(
    { bankAccountId: acct.id, method: 'check', checkNumber: '7004', paymentDate: '2026-07-02', invoiceIds: [invoice.id] },
    own, db,
  );
  await importTransactions(acct.id, [{ txnDate: '2026-07-02', amount: -10000, description: 'x', rawReference: '7004' }], 'manual', own, db);
  const txn = (await db.many('SELECT id FROM bank_transactions WHERE bank_account_id = ?', [acct.id]))[0];
  await confirmMatch(txn.id, pay.id, own, db);
  assert.equal(await assertInScope('bankTxn', txn.id, null, db), companyId);

  // A scope that excludes this company is refused (404, existence hidden).
  await assert.rejects(assertInScope('bankAccount', acct.id, [companyId + 999], db), /לא נמצאה/);
  await assert.rejects(assertInScope('bankTxn', txn.id, [companyId + 999], db), /לא נמצאה/);
});
