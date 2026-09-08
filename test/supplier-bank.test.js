// פרטי בנק של ספק — the destination a transfer is allowed to go to.
//
// THE FRAUD THIS GUARDS: not a fake invoice. A REAL invoice, a real amount, correctly approved,
// paid into an account somebody quietly changed — an email from "the supplier" announcing new bank
// details is how a business this size actually loses money, and nothing about the invoice looks
// wrong. So the destination is owner-only, every change is kept with who and when, and a transfer
// to a supplier whose details changed recently says so at the moment of approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import {
  createSupplier, approveSupplier, getSupplier, setSupplierBank, supplierBankHistory,
  bankChangedRecently, BANK_CHANGE_WARN_DAYS,
} from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createTransfer, listTransfers } from '../src/services/transfers.js';

const DETAILS = { bankName: 'הפועלים', bankBranch: '428', bankAccount: '123456', bankHolder: 'טרה בע"מ' };

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const sec = await secretary(db);
  const store = await firstStore(db);
  const sup = await approveSupplier((await createSupplier({ name: 'טרה' }, sec, db)).id, ow, db);
  return { db, ow, sec, store, sup };
}

test('setting the destination records it, stamped with who and when', async () => {
  const { db, ow, sup } = await world();
  const after = await setSupplierBank(sup.id, DETAILS, ow, db);
  assert.equal(after.bank_account, '123456');
  assert.equal(after.bank_holder, 'טרה בע"מ');
  assert.ok(after.bank_updated_at);
  assert.equal(Number(after.bank_updated_by), ow.id);
});

test('🔒 only the owner may change where the money goes', async () => {
  const { db, sec, sup } = await world();
  await assert.rejects(() => setSupplierBank(sup.id, DETAILS, sec, db), /בעלים בלבד/);
});

test('every change keeps the account it replaced — the trail is the point', async () => {
  const { db, ow, sup } = await world();
  await setSupplierBank(sup.id, DETAILS, ow, db);
  await setSupplierBank(sup.id, { ...DETAILS, bankAccount: '999999', note: 'אומת טלפונית' }, ow, db);

  const history = await supplierBankHistory(sup.id, db);
  assert.equal(history.length, 2);
  assert.equal(history[0].old_account, '123456', 'the newest entry remembers what it replaced');
  assert.equal(history[0].new_account, '999999');
  assert.equal(history[0].note, 'אומת טלפונית');
  assert.equal(history[0].changed_by_name, ow.name);
  assert.equal(history[1].old_account, null, 'the first entry had nothing before it');
});

test('re-saving the same details is not a change and leaves no trail', async () => {
  const { db, ow, sup } = await world();
  await setSupplierBank(sup.id, DETAILS, ow, db);
  await setSupplierBank(sup.id, DETAILS, ow, db);
  assert.equal((await supplierBankHistory(sup.id, db)).length, 1);
});

test('the recent-change window is what the approval screen warns on', () => {
  const now = new Date('2026-09-08T10:00:00Z');
  const days = (n) => {
    const d = new Date(now.getTime() - n * 86400000);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
  };
  assert.equal(bankChangedRecently({ bank_updated_at: days(3) }, BANK_CHANGE_WARN_DAYS, now), true);
  assert.equal(bankChangedRecently({ bank_updated_at: days(BANK_CHANGE_WARN_DAYS + 5) }, BANK_CHANGE_WARN_DAYS, now), false);
  assert.equal(bankChangedRecently({ bank_updated_at: null }, BANK_CHANGE_WARN_DAYS, now), false);
});

test('the transfer row carries the destination, and flags a missing or freshly-changed one', async () => {
  const { db, ow, sec, store, sup } = await world();
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'BK-1', invoiceDate: '2026-06-01',
      amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice' }, ow, db,
  );
  const inv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'BK-1'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  await createTransfer({ invoiceIds: [inv.id] }, sec, db);

  // No destination set yet → the owner is told before approving, not after.
  let row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.bankMissing, true);

  // Set it → the row shows where the money goes, and warns because it was just changed.
  await setSupplierBank(sup.id, DETAILS, ow, db);
  row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.bankMissing, false);
  assert.equal(row.bank.bank_account, '123456');
  assert.equal(row.bankChangedRecently, true, 'just changed → the approval screen says so');
});
