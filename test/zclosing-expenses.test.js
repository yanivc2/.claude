import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import {
  createZClosing, getZClosing, updateZClosing, deleteZClosing,
  listClosingExpenses, recentClosingExpenses,
} from '../src/services/zclosing.js';
import { createEmployee } from '../src/services/employees.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { toAgorot } from '../src/lib/money.js';

function baseInput(store, overrides = {}) {
  return {
    employeeFirst: 'רון', employeeLast: 'לוי', storeId: store.id, zNumber: '901',
    drawerCash: 0, startedAt: '2026-08-14 09:00',
    counts: { 200: 1 }, // ₪200 cash
    expenses: [],
    ...overrides,
  };
}

test('register closing stores rich cash expenses (kind/date/employee/invoice) and aggregates them', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const sec = await secretary(x);
  const store = await firstStore(x);
  const emp = await createEmployee({ firstName: 'דנה', lastName: 'כהן' }, o, x);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק א' }, sec, x)).id, o, x);
  const inv = (await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-9', invoiceDate: '2026-08-10', amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice' },
    sec, x,
  )).invoice;

  const id = await createZClosing(baseInput(store, {
    employeeId: emp.id, employeeFirst: '', employeeLast: '',
    expenses: [
      { kind: 'manual', expenseDate: '2026-08-14', payerName: 'משה', purpose: 'קפה', amount: 1500 },
      { kind: 'advance', expenseDate: '2026-08-14', employeeId: emp.id, amount: 20000 },
      { kind: 'invoice', expenseDate: '2026-08-14', invoiceId: inv.id, amount: 11700 },
    ],
  }), o, x);

  // Top-level employee name resolved from the picked employee.
  const c = await getZClosing(id, x);
  assert.equal(c.employee_id, emp.id);
  assert.equal(c.employee_first, 'דנה');
  assert.equal(c.total_expenses, 1500 + 20000 + 11700);
  assert.equal(c.total_cash, 20000); // ₪200
  assert.equal(c.grand_total, 20000 + 33200);

  // Expense lines persisted with the right kind + links.
  const lines = await listClosingExpenses(id, x);
  assert.equal(lines.length, 3);
  const invoiceLine = lines.find((l) => l.description_type === 'invoice');
  assert.equal(invoiceLine.invoice_id, inv.id);
  assert.equal(invoiceLine.invoice_number, 'INV-9');
  const advanceLine = lines.find((l) => l.description_type === 'advance');
  assert.equal(advanceLine.employee_id, emp.id);
  assert.equal(advanceLine.emp_first, 'דנה');

  // Aggregation (owner scope = all) surfaces every positive line, newest first.
  const recent = await recentClosingExpenses(null, 50, x);
  assert.equal(recent.length, 3);
  assert.ok(recent.every((r) => r.amount > 0));
});

test('register balancing (איזון קופות) persists per-register counts, totals, and survives edit', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);

  const id = await createZClosing(baseInput(store, {
    registers: [
      { first: 'רון', last: 'לוי', register: '1', storeId: store.id, counts: { 200: 2, 100: 1, 50: 0 } },
      { first: 'דנה', last: 'כהן', register: '2', storeId: store.id, counts: { 20: 3 } },
      { first: '', last: '', register: '', storeId: null, counts: {} }, // empty → dropped
    ],
  }), o, x);

  const c = await getZClosing(id, x);
  const regs = JSON.parse(c.registers);
  assert.equal(regs.length, 2); // the empty register was dropped
  assert.equal(regs[0].first, 'רון');
  assert.equal(regs[0].register, '1');
  assert.equal(regs[0].storeId, store.id);
  assert.equal(regs[0].total, 2 * 20000 + 1 * 10000); // ₪200×2 + ₪100×1 = 50000 agorot
  assert.equal(regs[0].breakdown['200'], 2);
  assert.equal(regs[1].total, 3 * 2000); // ₪20×3 = 6000 agorot
  // Registers are independent of the main drawer count.
  assert.equal(c.total_cash, 20000); // still just baseInput's ₪200

  // Editing with no registers clears them.
  await updateZClosing(id, baseInput(store, { registers: [] }), o, x);
  assert.equal(JSON.parse((await getZClosing(id, x)).registers).length, 0);
});

test('editing a closing replaces its expense lines; delete cascades them', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const id = await createZClosing(baseInput(store, {
    expenses: [{ kind: 'manual', payerName: 'א', purpose: 'x', amount: 1000 }],
  }), o, x);
  assert.equal((await listClosingExpenses(id, x)).length, 1);

  await updateZClosing(id, baseInput(store, {
    expenses: [
      { kind: 'manual', payerName: 'ב', purpose: 'y', amount: 500 },
      { kind: 'manual', payerName: 'ג', purpose: 'z', amount: 700 },
    ],
  }), o, x);
  const lines = await listClosingExpenses(id, x);
  assert.equal(lines.length, 2);
  assert.equal((await getZClosing(id, x)).total_expenses, 1200);

  await deleteZClosing(id, o, x);
  assert.equal((await listClosingExpenses(id, x)).length, 0);
});
