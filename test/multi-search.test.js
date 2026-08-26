import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, listInvoices } from '../src/services/invoices.js';
import { invoiceLookup } from '../src/services/reports.js';
import { lookupChecks } from '../src/services/payments.js';
import { parseSearchTerms, anyTermLike } from '../src/lib/search.js';
import { toAgorot } from '../src/lib/money.js';

test('parseSearchTerms splits on space/comma/semicolon/newline, dedupes', () => {
  assert.deepEqual(parseSearchTerms('100, 200  300\n100;400'), ['100', '200', '300', '400']);
  assert.deepEqual(parseSearchTerms(''), []);
  assert.deepEqual(parseSearchTerms('  '), []);
});

test('anyTermLike builds an OR-of-terms clause with a param per column per term', () => {
  const m = anyTermLike(['a', 'b'], ['x', 'y']);
  assert.equal(m.sql, '((x LIKE ? OR y LIKE ?) OR (x LIKE ? OR y LIKE ?))');
  assert.deepEqual(m.params, ['%a%', '%a%', '%b%', '%b%']);
});

test('invoiceLookup + listInvoices find several invoice numbers in one search', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const sec = await secretary(x);
  const store = await firstStore(x);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, x)).id, o, x);
  const mk = async (num, amt) => (await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: num, invoiceDate: '2026-08-10', amountBeforeVat: toAgorot(amt), vatAmount: 0, docType: 'tax_invoice', confirm: true },
    sec, x,
  )).invoice;
  await mk('INV-100', '10'); await mk('INV-200', '20'); await mk('INV-300', '30');

  const two = await invoiceLookup('INV-100 INV-300', { scope: null }, x);
  assert.deepEqual(two.map((r) => r.invoice_number).sort(), ['INV-100', 'INV-300']);

  const listed = await listInvoices({ q: 'INV-100, INV-200' }, x);
  assert.deepEqual(listed.map((r) => r.invoice_number).sort(), ['INV-100', 'INV-200']);

  const one = await invoiceLookup('INV-200', { scope: null }, x);
  assert.equal(one.length, 1);
});

// SQLite only: lookupChecks uses a correlated subquery for the supplier name that pg-mem can't
// plan (real Postgres runs it fine — it's the live dashboard query). The multi-term OR clause
// itself is proven PG-valid by the invoiceLookup test above.
test('lookupChecks finds several check numbers at once', { skip: !!process.env.TEST_PG }, async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const ba = await accountForStore(x, store.id);
  await x.run('INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)', [ba.id, 'check', '5001', '2026-08-12', 1000, o.id]);
  await x.run('INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)', [ba.id, 'check', '5002', '2026-08-12', 2000, o.id]);
  await x.run('INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, created_by) VALUES (?, ?, ?, ?, ?, ?)', [ba.id, 'check', '5003', '2026-08-12', 3000, o.id]);

  const res = await lookupChecks('5001 5003', null, x);
  assert.deepEqual(res.map((r) => r.check_number).sort(), ['5001', '5003']);
});
