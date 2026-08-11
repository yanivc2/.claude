import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import {
  createEmployee, listEmployees, deleteEmployee, listEmployeeLedger, employeeTotals,
} from '../src/services/employees.js';
import { createZReport, replaceExpenses, listExpenses, cashPaymentsForInvoice } from '../src/services/zreports.js';

async function seedInvoice(x, ownerId, storeId) {
  const sup = await x.run("INSERT INTO suppliers (name, status) VALUES ('ספק', 'approved')", []);
  const st = await x.one('SELECT company_id FROM stores WHERE id = ?', [storeId]);
  const inv = await x.run(
    `INSERT INTO invoices (supplier_id, company_id, store_id, invoice_number, invoice_date,
       amount_before_vat, vat_amount, total_amount, doc_type, created_by)
     VALUES (?, ?, ?, '1001', '2026-01-01', 10000, 1700, 11700, 'tax_invoice', ?)`,
    [sup.lastInsertRowid, st.company_id, storeId, ownerId],
  );
  return inv.lastInsertRowid;
}

async function newZ(x, o, storeId) {
  return createZReport({ storeId, zNumber: '500', zDate: '2026-01-05', drawerCash: 100000 }, o, x);
}

test('createEmployee validates and lists', async () => {
  const x = await freshDb();
  const o = await owner(x);
  await assert.rejects(() => createEmployee({ firstName: '', lastName: 'כהן' }, o, x), /חובה/);
  const e = await createEmployee({ firstName: 'דנה', lastName: 'לוי' }, o, x);
  assert.equal(e.first_name, 'דנה');
  const list = await listEmployees({}, x);
  assert.equal(list.length, 1);
});

test('advance line on a Z feeds the employee ledger + totals', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const emp = await createEmployee({ firstName: 'רון', lastName: 'ברק' }, o, x);
  const z = await newZ(x, o, store.id);
  await replaceExpenses(z.id, [
    { kind: 'advance', employeeId: emp.id, amount: 30000, expenseDate: '2026-01-05' },
    { kind: 'salary', employeeId: emp.id, amount: 50000, expenseDate: '2026-01-05' },
    { kind: 'manual', purpose: 'קפה', amount: 1500 },
  ], o, x);

  const ledger = await listEmployeeLedger({}, x);
  assert.equal(ledger.length, 2, 'manual line is not in the employee ledger');
  assert.ok(ledger.every((r) => r.first_name === 'רון'));

  const totals = await employeeTotals(x);
  const row = totals.find((t) => t.id === emp.id);
  assert.equal(row.advances, 30000);
  assert.equal(row.salary, 50000);
  assert.equal(row.lines, 2);
});

test('invoice-kind expense links the invoice; manual/advance never do', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const invId = await seedInvoice(x, o.id, store.id);
  const emp = await createEmployee({ firstName: 'א', lastName: 'ב' }, o, x);
  const z = await newZ(x, o, store.id);
  await replaceExpenses(z.id, [
    { kind: 'invoice', invoiceId: invId, employeeId: emp.id /* should be ignored */, amount: 11700 },
    { kind: 'advance', employeeId: emp.id, invoiceId: invId /* should be ignored */, amount: 5000 },
  ], o, x);

  const lines = await listExpenses(z.id, x);
  const invLine = lines.find((l) => l.description_type === 'invoice');
  assert.equal(invLine.invoice_id, invId);
  assert.equal(invLine.employee_id, null, 'invoice line does not keep an employee');
  const advLine = lines.find((l) => l.description_type === 'advance');
  assert.equal(advLine.employee_id, emp.id);
  assert.equal(advLine.invoice_id, null, 'advance line does not keep an invoice');

  const cash = await cashPaymentsForInvoice(invId, x);
  assert.equal(cash.length, 1);
  assert.equal(cash[0].amount, 11700);
  assert.equal(cash[0].z_number, '500');
});

test('deleteEmployee deactivates when they have lines, hard-deletes otherwise', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const withLines = await createEmployee({ firstName: 'עם', lastName: 'רישום' }, o, x);
  const clean = await createEmployee({ firstName: 'ללא', lastName: 'רישום' }, o, x);
  const z = await newZ(x, o, store.id);
  await replaceExpenses(z.id, [{ kind: 'advance', employeeId: withLines.id, amount: 1000 }], o, x);

  const r1 = await deleteEmployee(withLines.id, o, x);
  assert.equal(r1.deactivated, true);
  assert.equal((await x.one('SELECT active FROM employees WHERE id = ?', [withLines.id])).active, 0);

  const r2 = await deleteEmployee(clean.id, o, x);
  assert.equal(r2.deactivated, false);
  assert.equal(await x.one('SELECT id FROM employees WHERE id = ?', [clean.id]), undefined);
});
