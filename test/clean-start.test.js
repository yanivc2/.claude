import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { cleanStartInvoicesPaymentsZ } from '../src/services/backup.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createZClosing, getZClosing } from '../src/services/zclosing.js';
import { createEmployee } from '../src/services/employees.js';
import { toAgorot } from '../src/lib/money.js';

const count = async (x, t) => Number((await x.one(`SELECT COUNT(*) AS n FROM ${t}`, [])).n);

// Build a full fixture: an invoice with a line/OCR, a payment applied to it, a matched bank txn,
// a Z report with an invoice-linked expense, a deposit on that Z, a catalog price from the invoice,
// and a register closing whose cash-expense points at the invoice. Then clean-start and assert the
// invoices/payments/Z go while the closings + reference data survive (with dead links nulled).
async function fixture(x) {
  const o = await owner(x);
  const sec = await secretary(x);
  const store = await firstStore(x);
  const ba = await accountForStore(x, store.id);
  const emp = await createEmployee({ firstName: 'דנה', lastName: 'כהן' }, o, x);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, x)).id, o, x);

  const prod = (await x.run('INSERT INTO products (supplier_id, name, barcode) VALUES (?, ?, ?)', [sup.id, 'חלב', '7290000000001'])).lastInsertRowid;
  const inv = (await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-1', invoiceDate: '2026-08-10', amountBeforeVat: toAgorot('100'), vatAmount: toAgorot('17'), docType: 'tax_invoice' },
    sec, x,
  )).invoice;
  // RETURNING invoice_id keeps the adapter from injecting "RETURNING id" (this table's PK is invoice_id).
  await x.run('INSERT INTO invoice_ocr (invoice_id, raw_text) VALUES (?, ?) RETURNING invoice_id', [inv.id, 'ocr']);
  await x.run('INSERT INTO product_prices (product_id, invoice_id, price, price_date) VALUES (?, ?, ?, ?)', [prod, inv.id, toAgorot('5'), '2026-08-10']);

  const pay = (await x.run(
    'INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [ba.id, 'check', '5001', '2026-08-12', toAgorot('117'), o.id],
  )).lastInsertRowid;
  await x.run('INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, ?)', [pay, inv.id, toAgorot('117')]);
  await x.run('INSERT INTO bank_transactions (bank_account_id, txn_date, amount, source, matched_payment_id) VALUES (?, ?, ?, ?, ?)', [ba.id, '2026-08-13', toAgorot('117'), 'scraper', pay]);

  const zr = (await x.run('INSERT INTO z_reports (store_id, z_number, z_date, created_by) VALUES (?, ?, ?, ?)', [store.id, '77', '2026-08-11', o.id])).lastInsertRowid;
  await x.run('INSERT INTO z_expenses (z_report_id, amount, invoice_id, description_type) VALUES (?, ?, ?, ?)', [zr, toAgorot('50'), inv.id, 'invoice']);
  await x.run('INSERT INTO deposits (store_id, z_report_id, deposit_date, amount, created_by) VALUES (?, ?, ?, ?, ?)', [store.id, zr, '2026-08-11', toAgorot('900'), o.id]);

  await x.run(
    'INSERT INTO invoice_drafts (store_id, company_id, supplier_id, status, images, created_by) VALUES (?, ?, ?, ?, ?, ?)',
    [store.id, store.company_id, sup.id, 'uploaded', '[]', o.id],
  );

  const closingId = await createZClosing({
    employeeFirst: '', employeeLast: '', employeeId: emp.id, storeId: store.id, zNumber: '77',
    drawerCash: 0, startedAt: '2026-08-11 09:00', counts: { 200: 1 },
    expenses: [{ kind: 'invoice', expenseDate: '2026-08-11', invoiceId: inv.id, amount: toAgorot('117') }],
    registers: [{ first: 'א', last: 'ב', register: '1', storeId: store.id, counts: { 100: 2 } }],
  }, o, x);

  return { o, closingId, invId: inv.id };
}

test('clean-start wipes invoices/payments/Z + drafts, keeps closings & reference data (SQLite/PG)', async () => {
  const x = await freshDb();
  const { o, closingId } = await fixture(x);

  // Sanity: everything is present first.
  assert.equal(await count(x, 'invoices'), 1);
  assert.equal(await count(x, 'payments'), 1);
  assert.equal(await count(x, 'z_reports'), 1);
  assert.equal(await count(x, 'invoice_drafts'), 1);
  assert.equal(await count(x, 'z_closing_expenses'), 1);

  const res = await cleanStartInvoicesPaymentsZ(o, x);
  assert.deepEqual(res.counts, { invoices: 1, payments: 1, zReports: 1, drafts: 1 });

  // Deleted (+ their cascading children).
  for (const t of ['invoices', 'invoice_lines', 'invoice_ocr', 'payments', 'payment_lines', 'z_reports', 'z_expenses', 'invoice_drafts']) {
    assert.equal(await count(x, t), 0, `${t} should be empty`);
  }

  // Kept — register closings survive intact, invoice link on the cash expense nulled.
  assert.equal(await count(x, 'z_closings'), 1);
  assert.equal(await count(x, 'z_closing_expenses'), 1);
  assert.equal((await x.one('SELECT invoice_id FROM z_closing_expenses LIMIT 1', [])).invoice_id, null);
  const c = await getZClosing(closingId, x);
  assert.ok(c && JSON.parse(c.registers).length === 1, 'closing + its registers survive');

  // Kept — reference rows survive with their dead links nulled.
  assert.equal(await count(x, 'deposits'), 1);
  assert.equal((await x.one('SELECT z_report_id FROM deposits LIMIT 1', [])).z_report_id, null);
  assert.equal(await count(x, 'product_prices'), 1);
  assert.equal((await x.one('SELECT invoice_id FROM product_prices LIMIT 1', [])).invoice_id, null);
  assert.equal(await count(x, 'bank_transactions'), 1);
  assert.equal((await x.one('SELECT matched_payment_id FROM bank_transactions LIMIT 1', [])).matched_payment_id, null);

  // Kept — business setup / catalog / staff untouched.
  assert.equal(await count(x, 'suppliers'), 1);
  assert.equal(await count(x, 'products'), 1);
  assert.equal(await count(x, 'employees'), 1);
});
