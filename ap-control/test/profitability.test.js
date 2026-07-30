import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { addSalesEntry, deleteSalesEntry, listSalesEntries } from '../src/services/sales.js';
import { profitability } from '../src/services/reports.js';
import { toAgorot } from '../src/lib/money.js';

function invoice(db, sup, store, over) {
  return createInvoice(
    {
      supplierId: sup.id,
      storeId: store.id,
      invoiceNumber: over.invoiceNumber,
      invoiceDate: over.invoiceDate,
      amountBeforeVat: over.beforeVat,
      vatAmount: over.vat,
      docType: over.docType || 'tax_invoice',
    },
    secretary(db),
    db,
  ).invoice;
}

test('profitability: net purchases vs sales, gross profit and margin per store, range-filtered', () => {
  const db = freshDb();
  const store = firstStore(db);
  const sup = approveSupplier(createSupplier({ name: 'ספק' }, secretary(db), db).id, owner(db), db);

  // July purchases: 1170 + 585 - 117 (credit) = 1638
  invoice(db, sup, store, { invoiceNumber: 'P1', invoiceDate: '2026-07-03', beforeVat: toAgorot('1000'), vat: toAgorot('170') });
  invoice(db, sup, store, { invoiceNumber: 'P2', invoiceDate: '2026-07-10', beforeVat: toAgorot('500'), vat: toAgorot('85') });
  invoice(db, sup, store, { invoiceNumber: 'C1', invoiceDate: '2026-07-12', beforeVat: toAgorot('100'), vat: toAgorot('17'), docType: 'credit_note' });
  // August invoice must NOT count in July range
  invoice(db, sup, store, { invoiceNumber: 'P3', invoiceDate: '2026-08-02', beforeVat: toAgorot('2000'), vat: toAgorot('340') });

  // July sales (Z): 5000 + 3000 = 8000
  addSalesEntry({ storeId: store.id, saleDate: '2026-07-03', amount: toAgorot('5000') }, secretary(db), db);
  addSalesEntry({ storeId: store.id, saleDate: '2026-07-31', amount: toAgorot('3000') }, secretary(db), db);
  addSalesEntry({ storeId: store.id, saleDate: '2026-08-01', amount: toAgorot('9999') }, secretary(db), db); // out of range

  const { stores, totals } = profitability('2026-07-01', '2026-07-31', db);
  const row = stores.find((s) => s.id === store.id);
  assert.equal(row.purchases, toAgorot('1638'));
  assert.equal(row.sales, toAgorot('8000'));
  assert.equal(row.grossProfit, toAgorot('6362')); // 8000 - 1638
  assert.equal(Number(row.marginPct.toFixed(2)), Number(((6362 / 8000) * 100).toFixed(2)));

  // totals aggregate across stores (only this store has data)
  assert.equal(totals.purchases, toAgorot('1638'));
  assert.equal(totals.sales, toAgorot('8000'));
  assert.equal(totals.grossProfit, toAgorot('6362'));
});

test('a store with sales=0 reports null margin (no divide-by-zero)', () => {
  const db = freshDb();
  const { stores } = profitability('2026-01-01', '2026-01-31', db);
  assert.ok(stores.every((s) => s.marginPct === null));
});

test('addSalesEntry rejects a negative amount; delete removes it', () => {
  const db = freshDb();
  const store = firstStore(db);
  assert.throws(
    () => addSalesEntry({ storeId: store.id, saleDate: '2026-07-01', amount: -100 }, secretary(db), db),
    /לא-שלילי/,
  );
  const e = addSalesEntry({ storeId: store.id, saleDate: '2026-07-01', amount: toAgorot('1000') }, secretary(db), db);
  assert.equal(listSalesEntries(50, db).length, 1);
  deleteSalesEntry(e.id, secretary(db), db);
  assert.equal(listSalesEntries(50, db).length, 0);
});
