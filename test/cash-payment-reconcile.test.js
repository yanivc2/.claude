import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZClosing } from '../src/services/zclosing.js';
import { unmatchedCashExpenses } from '../src/services/zreports.js';

// Owner decision "תשלום מזומן = מטופל": a register cash expense that has a matching cash PAYMENT
// (same store + amount, non-voided) is reconciled and drops off the dashboard's "unmatched" list —
// one payment clears one expense, no more.
test('unmatchedCashExpenses: a cash payment clears one same-store/amount expense (1:1)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='טרה'", []);

  // an invoice paid via a CASH payment of ₪609
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: '94420', invoiceDate: '2026-08-25', amountBeforeVat: 60900, vatAmount: 0, docType: 'tax_invoice' }, ow, db);
  const inv = await db.one("SELECT id FROM invoices WHERE invoice_number='94420'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  await createPayment({ bankAccountId: ba.id, method: 'cash', payerName: 'הסניף', paymentDate: '2026-08-25', invoiceIds: [inv.id] }, ow, db);

  // a register close with TWO ₪609 cash expenses: one matches the payment, one does not
  await createZClosing({ employeeFirst: 'א', employeeLast: 'ב', zNumber: '2166', drawerCash: 200000, storeId: store.id, counts: {}, registers: [], expenses: [
    { kind: 'manual', expenseDate: '2026-08-25', payerName: 'טרה', purpose: 'טרה', amount: 60900 },
    { kind: 'manual', expenseDate: '2026-08-25', payerName: 'אחר', purpose: 'אחר', amount: 60900 },
  ] }, ow, db);

  const unmatched = await unmatchedCashExpenses(null, 30, store.id, db);
  const n609 = unmatched.filter((e) => Number(e.amount) === 60900).length;
  assert.equal(n609, 1); // exactly one remains — the payment cleared the other

  // a voided cash payment must NOT clear anything
  await db.run("UPDATE payments SET status='voided' WHERE method='cash'", []);
  const after = await unmatchedCashExpenses(null, 30, store.id, db);
  assert.equal(after.filter((e) => Number(e.amount) === 60900).length, 2);
});
