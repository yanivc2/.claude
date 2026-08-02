import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { purchasesReport } from '../src/services/reports.js';
import { toAgorot } from '../src/lib/money.js';

async function invoice(db, sup, store, over) {
  const { invoice: inv } = await createInvoice(
    {
      supplierId: sup.id,
      storeId: store.id,
      invoiceNumber: over.invoiceNumber,
      invoiceDate: over.invoiceDate,
      amountBeforeVat: over.beforeVat,
      vatAmount: over.vat,
      docType: over.docType || 'tax_invoice',
    },
    await secretary(db),
    db,
  );
  return inv;
}

test('purchasesReport totals invoices (credit notes negative), groups by supplier, filters by date', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const o = await owner(db);
  const supA = await approveSupplier((await createSupplier({ name: 'ספק א' }, sec, db)).id, o, db);
  const supB = await approveSupplier((await createSupplier({ name: 'ספק ב' }, sec, db)).id, o, db);

  await invoice(db, supA, store, { invoiceNumber: 'A1', invoiceDate: '2026-07-03', beforeVat: toAgorot('1000'), vat: toAgorot('180') });
  await invoice(db, supA, store, { invoiceNumber: 'A2', invoiceDate: '2026-07-10', beforeVat: toAgorot('500'), vat: toAgorot('90') });
  await invoice(db, supB, store, { invoiceNumber: 'B1', invoiceDate: '2026-07-15', beforeVat: toAgorot('2000'), vat: toAgorot('360') });
  await invoice(db, supB, store, { invoiceNumber: 'C1', invoiceDate: '2026-07-20', beforeVat: toAgorot('100'), vat: toAgorot('18'), docType: 'credit_note' });
  await invoice(db, supA, store, { invoiceNumber: 'A3', invoiceDate: '2026-08-05', beforeVat: toAgorot('9999'), vat: toAgorot('0') });

  // July only.
  const rep = await purchasesReport({ from: '2026-07-01', to: '2026-07-31' }, db);
  assert.equal(rep.count, 4);
  // 1180 + 590 + 2360 - 118 = 4012
  assert.equal(rep.total, toAgorot('4012'));
  assert.equal(rep.bySupplier.length, 2);
  // sorted by total desc: supA (1770) then supB (2242)? supB=2360-118=2242 > supA=1770
  assert.equal(rep.bySupplier[0].total, toAgorot('2242'));
  assert.equal(rep.bySupplier[1].total, toAgorot('1770'));
});

test('purchasesReport filters by supplier and store', async () => {
  const db = await freshDb();
  const store = await firstStore(db);
  const sec = await secretary(db);
  const o = await owner(db);
  const supA = await approveSupplier((await createSupplier({ name: 'ספק א' }, sec, db)).id, o, db);
  const supB = await approveSupplier((await createSupplier({ name: 'ספק ב' }, sec, db)).id, o, db);
  await invoice(db, supA, store, { invoiceNumber: 'A1', invoiceDate: '2026-07-03', beforeVat: toAgorot('1000'), vat: toAgorot('180') });
  await invoice(db, supB, store, { invoiceNumber: 'B1', invoiceDate: '2026-07-15', beforeVat: toAgorot('2000'), vat: toAgorot('360') });

  const onlyA = await purchasesReport({ supplierId: supA.id }, db);
  assert.equal(onlyA.count, 1);
  assert.equal(onlyA.total, toAgorot('1180'));

  const byStore = await purchasesReport({ storeId: store.id }, db);
  assert.equal(byStore.count, 2);
});
