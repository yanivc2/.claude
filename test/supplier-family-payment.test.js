// Consolidated payment across a parent supplier and its subsidiary (e.g. קוקה קולה + טרה):
// linking, the payment "family", one payment spanning both, and the link validation rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { createSupplier, approveSupplier, updateSupplier, supplierFamilyIds, getSupplier } from '../src/services/suppliers.js';
import { createInvoice, listPayable } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';

async function setup() {
  const db = await freshDb();
  const own = await owner(db);
  const st = await firstStore(db);
  const coke = await approveSupplier((await createSupplier({ name: 'קוקה קולה' }, own, db)).id, own, db);
  const tara = await approveSupplier((await createSupplier({ name: 'טרה' }, own, db)).id, own, db);
  return { db, own, st, coke, tara };
}

test('linking a subsidiary to a parent groups both into one payment family', async () => {
  const { db, own, coke, tara } = await setup();
  await updateSupplier(tara.id, { name: 'טרה', parentSupplierId: coke.id }, own, db);
  assert.equal((await getSupplier(tara.id, db)).parent_supplier_id, coke.id);

  const famFromTara = (await supplierFamilyIds(tara.id, db)).sort();
  const famFromCoke = (await supplierFamilyIds(coke.id, db)).sort();
  assert.deepEqual(famFromTara, [coke.id, tara.id].sort());
  assert.deepEqual(famFromCoke, [coke.id, tara.id].sort()); // same family from either side
});

test('one payment can span a parent and subsidiary invoice in the same store', async () => {
  const { db, own, st, coke, tara } = await setup();
  await updateSupplier(tara.id, { name: 'טרה', parentSupplierId: coke.id }, own, db);
  const invCoke = (await createInvoice({ supplierId: coke.id, storeId: st.id, invoiceNumber: 'CK1', invoiceDate: '2026-08-01', amountBeforeVat: 10000, vatAmount: 1700, docType: 'tax_invoice' }, own, db)).invoice;
  const invTara = (await createInvoice({ supplierId: tara.id, storeId: st.id, invoiceNumber: 'TR1', invoiceDate: '2026-08-01', amountBeforeVat: 5000, vatAmount: 850, docType: 'tax_invoice' }, own, db)).invoice;

  // listPayable exposes the parent id so the UI can group them; the family covers both suppliers.
  const payable = await listPayable(null, db);
  const fam = new Set(await supplierFamilyIds(coke.id, db));
  const groupInvoices = payable.filter((i) => fam.has(i.supplier_id) && i.store_id === st.id).map((i) => i.id).sort();
  assert.deepEqual(groupInvoices, [invCoke.id, invTara.id].sort());

  const ba = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id]);
  const pay = await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '3131', paymentDate: '2026-08-05', invoiceIds: [invCoke.id, invTara.id] }, own, db);
  assert.equal(pay.amount, 11700 + 5850);
  assert.equal(pay.lines.length, 2);
});

test('link validation: no self-parent, and the parent must be top-level', async () => {
  const { db, own, coke, tara } = await setup();
  await assert.rejects(updateSupplier(coke.id, { name: 'קוקה קולה', parentSupplierId: coke.id }, own, db), /עצמו/);

  // Make tara a subsidiary of coke, then a third supplier can't point at tara (a subsidiary).
  await updateSupplier(tara.id, { name: 'טרה', parentSupplierId: coke.id }, own, db);
  const third = await approveSupplier((await createSupplier({ name: 'תנובה' }, own, db)).id, own, db);
  await assert.rejects(updateSupplier(third.id, { name: 'תנובה', parentSupplierId: tara.id }, own, db), /רמה העליונה/);

  // And coke (now a parent) can't itself be made a subsidiary.
  await assert.rejects(updateSupplier(coke.id, { name: 'קוקה קולה', parentSupplierId: third.id }, own, db), /חברת-אם של ספקים/);
});
