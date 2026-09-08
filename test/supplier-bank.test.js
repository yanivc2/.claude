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
  createSupplier, approveSupplier, setSupplierBankAccount, supplierBankHistory,
  supplierBankFor, listSupplierBankAccounts, verifySupplierBankAccount, deleteSupplierBankAccount,
  bankChangedRecently, BANK_CHANGE_WARN_DAYS,
} from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createTransfer, listTransfers } from '../src/services/transfers.js';

const DETAILS = { bankCode: '12', bankBranch: '428', bankAccount: '123456', bankHolder: 'טרה בע"מ' };

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
  const after = await setSupplierBankAccount(sup.id, DETAILS, ow, db);
  assert.equal(after.bank_account, '123456');
  assert.equal(after.bank_holder, 'טרה בע"מ');
  assert.equal(after.bank_code, '12');
  assert.equal(after.bank_name, 'בנק הפועלים', 'the name is DERIVED from the code, never typed');
  assert.equal(after.store_id, null, 'no store given → this is the default account');
  assert.ok(after.updated_at);
  assert.equal(Number(after.updated_by), ow.id);
});

test('🔒 only the owner may change where the money goes', async () => {
  const { db, sec, sup } = await world();
  await assert.rejects(() => setSupplierBankAccount(sup.id, DETAILS, sec, db), /בעלים בלבד/);
});

test('every change keeps the account it replaced — the trail is the point', async () => {
  const { db, ow, sup } = await world();
  await setSupplierBankAccount(sup.id, DETAILS, ow, db);
  await setSupplierBankAccount(sup.id, { ...DETAILS, bankAccount: '999999', note: 'אומת טלפונית' }, ow, db);

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
  await setSupplierBankAccount(sup.id, DETAILS, ow, db);
  await setSupplierBankAccount(sup.id, DETAILS, ow, db);
  assert.equal((await supplierBankHistory(sup.id, db)).length, 1);
});

test('the recent-change window is what the approval screen warns on', () => {
  const now = new Date('2026-09-08T10:00:00Z');
  const days = (n) => {
    const d = new Date(now.getTime() - n * 86400000);
    return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)}`;
  };
  assert.equal(bankChangedRecently({ updated_at: days(3) }, BANK_CHANGE_WARN_DAYS, now), true);
  assert.equal(bankChangedRecently({ updated_at: days(BANK_CHANGE_WARN_DAYS + 5) }, BANK_CHANGE_WARN_DAYS, now), false);
  assert.equal(bankChangedRecently({ updated_at: null }, BANK_CHANGE_WARN_DAYS, now), false);
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
  await setSupplierBankAccount(sup.id, DETAILS, ow, db);
  row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.bankMissing, false);
  assert.equal(row.bank.bank_account, '123456');
  assert.equal(row.bankChangedRecently, true, 'just changed → the approval screen says so');
});

test('a store may have its own account, and it beats the supplier default', async () => {
  const { db, ow, store, sup } = await world();
  await setSupplierBankAccount(sup.id, DETAILS, ow, db);                                  // ברירת מחדל
  await setSupplierBankAccount(sup.id, { ...DETAILS, storeId: store.id, bankAccount: '777777' }, ow, db);

  const dflt = await supplierBankFor(sup.id, null, db);
  assert.equal(dflt.bank_account, '123456');
  assert.equal(dflt.resolved_from, 'default');

  const mine = await supplierBankFor(sup.id, store.id, db);
  assert.equal(mine.bank_account, '777777', 'the store account wins over the default');
  assert.equal(mine.resolved_from, 'store');

  const other = await db.one('SELECT id FROM stores WHERE id <> ? LIMIT 1', [store.id]);
  if (other) {
    const fell = await supplierBankFor(sup.id, other.id, db);
    assert.equal(fell.bank_account, '123456', 'a store with no account of its own falls back');
    assert.equal(fell.resolved_from, 'default');
  }
  assert.equal((await listSupplierBankAccounts(sup.id, db)).length, 2);
});

test('🔴 a wrong check digit or a branch that is really an account number is REFUSED', async () => {
  const { db, ow, sup } = await world();
  await assert.rejects(
    () => setSupplierBankAccount(sup.id, { ...DETAILS, bankBranch: '4281' }, ow, db),
    /סניף/, 'four digits in the branch field is a pasted account number',
  );
  await assert.rejects(
    () => setSupplierBankAccount(sup.id, { ...DETAILS, holderTaxId: '123456789' }, ow, db),
    /ספרת ביקורת/,
  );
  await assert.rejects(
    () => setSupplierBankAccount(sup.id, { ...DETAILS, iban: 'IL620108000000099999998' }, ow, db),
    /IBAN/,
  );
  await assert.rejects(
    () => setSupplierBankAccount(sup.id, { ...DETAILS, bankCode: '77' }, ow, db),
    /קוד בנק/, 'a code outside the list is not a bank',
  );
  assert.equal((await listSupplierBankAccounts(sup.id, db)).length, 0, 'nothing was saved');
});

test('a holder that is not the supplier WARNS but still saves — blocking would push it off-system', async () => {
  const { db, ow, sup } = await world();
  const saved = await setSupplierBankAccount(sup.id, { ...DETAILS, bankHolder: 'יוסי כהן' }, ow, db);
  assert.equal(saved.bank_holder, 'יוסי כהן', 'saved — sometimes it is legitimately a different name');
  assert.ok(saved.warnings.some((w) => /אינו תואם/.test(w)), 'but the owner is told, in words');
});

test('אימות טלפוני נרשם — וכל שינוי בפרטים מבטל אותו', async () => {
  const { db, ow, sup } = await world();
  const acct = await setSupplierBankAccount(sup.id, DETAILS, ow, db);
  const verified = await verifySupplierBankAccount(acct.id, 'דיברתי עם רו״ח', ow, db);
  assert.ok(verified.verified_at);
  assert.equal(Number(verified.verified_by), ow.id);

  await setSupplierBankAccount(sup.id, { ...DETAILS, bankAccount: '555555' }, ow, db);
  const after = await supplierBankFor(sup.id, null, db);
  assert.equal(after.verified_at, null, 'an account that was verified and then changed is NOT verified');
});

test('🔒 verifying or deleting an account is owner-only, and a deletion is kept in the trail', async () => {
  const { db, ow, sec, sup } = await world();
  const acct = await setSupplierBankAccount(sup.id, DETAILS, ow, db);
  await assert.rejects(() => verifySupplierBankAccount(acct.id, null, sec, db), /בעלים בלבד/);
  await assert.rejects(() => deleteSupplierBankAccount(acct.id, sec, db), /בעלים בלבד/);

  await deleteSupplierBankAccount(acct.id, ow, db);
  assert.equal(await supplierBankFor(sup.id, null, db), null);
  const hist = await supplierBankHistory(sup.id, db);
  assert.equal(hist[0].note, 'החשבון נמחק');
  assert.equal(hist[0].old_account, '123456', 'what was deleted is still readable');
});

test('🔴 a supplier cannot end up with two accounts for the same store, or two defaults', async () => {
  const { db, ow, store, sup } = await world();
  await setSupplierBankAccount(sup.id, DETAILS, ow, db);
  await setSupplierBankAccount(sup.id, { ...DETAILS, storeId: store.id, bankAccount: '777777' }, ow, db);
  // Saving the same slot again UPDATES it — it must never add a second row, because two rows for
  // one store means nobody can say where the money goes.
  await setSupplierBankAccount(sup.id, { ...DETAILS, bankAccount: '222222' }, ow, db);
  await setSupplierBankAccount(sup.id, { ...DETAILS, storeId: store.id, bankAccount: '888888' }, ow, db);
  assert.equal((await listSupplierBankAccounts(sup.id, db)).length, 2);
  assert.equal((await supplierBankFor(sup.id, null, db)).bank_account, '222222');
  assert.equal((await supplierBankFor(sup.id, store.id, db)).bank_account, '888888');

  // And the database itself refuses a duplicate, not just the service.
  await assert.rejects(
    () => db.run('INSERT INTO supplier_bank_accounts (supplier_id, store_id, bank_account) VALUES (?, ?, ?)',
      [sup.id, null, '000000']),
    'a second default row is refused by the unique index',
  );
});
