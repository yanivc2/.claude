// "העברות בנקאיות" — a transfer is REQUESTED before the bank, not recorded after it.
//
// The design question behind these tests: software cannot stop somebody logging into the bank. So
// the guarantee is not "she cannot transfer without recording" — it is "she cannot transfer without
// recording AND get away with it". Three things carry that, and each is pinned below:
//   • a request can only be raised against an unpaid, approved invoice, and everything about the
//     money is derived from it (nothing is typed, so nothing can be inflated);
//   • the owner approves BEFORE the money moves, and executing without approval is refused;
//   • every outgoing movement the bank reports with no request behind it is an alarm — read from
//     the bank's own statement, from a date the owner sets, forward-looking only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import {
  createTransfer, approveTransfer, rejectTransfer, executeTransfer, cancelTransfer,
  listTransfers, transferableInvoices, untrackedTransfers, setWatchFrom, getWatchFrom,
  alertOnUntrackedTransfers, backfilled,
} from '../src/services/transfers.js';

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const sec = await secretary(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק ממתין', 'pending')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name = 'טרה'", []);
  const pending = await db.one("SELECT * FROM suppliers WHERE name = 'ספק ממתין'", []);
  let n = 0;
  const invoice = async ({ supplierId = sup.id, amount = 100000, approve = true, storeId = store.id } = {}) => {
    n += 1;
    await createInvoice(
      { supplierId, storeId, invoiceNumber: `TR-${n}`, invoiceDate: `2026-0${(n % 9) + 1}-0${(n % 8) + 1}`,
        amountBeforeVat: amount, vatAmount: 0, docType: 'tax_invoice' },
      ow, db,
    );
    const inv = await db.one('SELECT * FROM invoices WHERE invoice_number = ?', [`TR-${n}`]);
    if (approve) await approveInvoiceForPayment(inv.id, ow, db);
    return db.one('SELECT * FROM invoices WHERE id = ?', [inv.id]);
  };
  return { db, ow, sec, store, acct, sup, pending, invoice };
}

test('the amount is DERIVED from the ticked invoices — there is nothing to inflate', async () => {
  const { db, sec, invoice } = await world();
  const a = await invoice({ amount: 100000 });
  const b = await invoice({ amount: 250000 });
  const t = await createTransfer({ invoiceIds: [a.id, b.id] }, sec, db);
  assert.equal(t.amount, 350000, 'the sum of the invoices, not a typed number');
  assert.equal(Number(t.supplier_id), Number(a.supplier_id));
  assert.equal(t.status, 'pending');
  assert.ok(t.opened_at, 'stamped when raised — the anchor the back-fill check uses');
});

test('only an unpaid, approved invoice of an approved supplier can be transferred against', async () => {
  const { db, sec, invoice, pending } = await world();
  const notApproved = await invoice({ approve: false });
  await assert.rejects(() => createTransfer({ invoiceIds: [notApproved.id] }, sec, db), /מאושרת לתשלום/);

  const badSupplier = await invoice({ supplierId: pending.id, approve: false });
  await assert.rejects(() => createTransfer({ invoiceIds: [badSupplier.id] }, sec, db), /R1|מאושר/);

  // …and the picker never offers either of them in the first place.
  const offered = (await transferableInvoices({ scope: null }, db)).map((i) => Number(i.id));
  assert.ok(!offered.includes(Number(notApproved.id)));
  assert.ok(!offered.includes(Number(badSupplier.id)));
});

test('one transfer = one supplier and one store, and an invoice cannot be double-requested', async () => {
  const { db, sec, invoice, ow } = await world();
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק ב', 'approved')", []);
  const other = await db.one("SELECT * FROM suppliers WHERE name = 'ספק ב'", []);
  const a = await invoice();
  const b = await invoice({ supplierId: other.id });
  await assert.rejects(() => createTransfer({ invoiceIds: [a.id, b.id] }, sec, db), /ספק אחד/);

  await createTransfer({ invoiceIds: [a.id] }, sec, db);
  await assert.rejects(() => createTransfer({ invoiceIds: [a.id] }, sec, db), /כבר משויכת/);
  void ow;
});

test('🔒 executing before the owner approved is refused — that is the whole control', async () => {
  const { db, sec, ow, invoice } = await world();
  const inv = await invoice();
  const t = await createTransfer({ invoiceIds: [inv.id] }, sec, db);
  await assert.rejects(
    () => executeTransfer(t.id, { reference: 'ASM-1' }, sec, db),
    /ממתינה לאישור/,
    'no money may move before the owner approved',
  );

  await approveTransfer(t.id, ow, db);
  const done = await executeTransfer(t.id, { reference: 'ASM-1', paymentDate: '2026-05-02' }, sec, db);
  assert.equal(done.status, 'executed');
  assert.equal(done.reference, 'ASM-1');
  assert.ok(done.payment_id, 'executing creates the real payment through the ordinary path');

  // …which is what pays the invoice, with all the usual rules applied.
  const paid = await db.one('SELECT status FROM invoices WHERE id = ?', [inv.id]);
  assert.equal(paid.status, 'paid');
});

test('"נפרע" comes from the bank, never from a person', async () => {
  const { db, sec, ow, invoice } = await world();
  const inv = await invoice();
  const t = await createTransfer({ invoiceIds: [inv.id] }, sec, db);
  await approveTransfer(t.id, ow, db);
  await executeTransfer(t.id, { reference: 'ASM-2', paymentDate: '2026-05-02' }, sec, db);

  let row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.displayStatus, 'executed', 'recorded, but the money has not been seen yet');

  // Only the payment clearing — which the bank causes — turns it into נפרע.
  const after = await db.one('SELECT payment_id FROM bank_transfers WHERE id = ?', [t.id]);
  await db.run("UPDATE payments SET status = 'cleared' WHERE id = ?", [after.payment_id]);
  row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.displayStatus, 'cleared');
  // There is no stored 'cleared' status to set: the column only holds the workflow states.
  const stored = await db.one('SELECT status FROM bank_transfers WHERE id = ?', [t.id]);
  assert.equal(stored.status, 'executed');
});

test('a rejected or cancelled request cannot then be executed', async () => {
  const { db, sec, ow, invoice } = await world();
  // Different amounts: two identical totals for the same supplier trip the R4 duplicate warning.
  const a = await createTransfer({ invoiceIds: [(await invoice({ amount: 111000 })).id] }, sec, db);
  await rejectTransfer(a.id, 'לא מאושר', ow, db);
  await assert.rejects(() => executeTransfer(a.id, { reference: 'X' }, sec, db), /נדחה/);

  const b = await createTransfer({ invoiceIds: [(await invoice({ amount: 222000 })).id] }, sec, db);
  await cancelTransfer(b.id, sec, db);
  await assert.rejects(() => executeTransfer(b.id, { reference: 'X' }, sec, db), /בוטל/);
});

// --- the enforcement -----------------------------------------------------------------------------

test('🔴 an outgoing movement with no request behind it is reported — but only from the watch date', async () => {
  const { db, ow, acct } = await world();
  const debit = async (date, amount, description, ref = null) =>
    db.run(
      `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
       VALUES (?, ?, ?, ?, ?, 'csv')`,
      [acct.id, date, amount, description, ref],
    );
  await debit('2026-01-15', -500000, 'העברה לספק');   // before the watch — history
  await debit('2026-06-10', -300000, 'העברה לספק');   // after — the real case

  // Off by default: nothing is reported until the owner turns it on.
  assert.equal(await getWatchFrom(db), null);
  assert.deepEqual(await untrackedTransfers({ scope: null }, db), []);

  await setWatchFrom('2026-06-01', ow, db);
  const rows = await untrackedTransfers({ scope: null }, db);
  assert.equal(rows.length, 1, 'forward-looking only — the January movement is not judged');
  assert.equal(rows[0].txn_date, '2026-06-10');
});

test('a movement that carries a known identifier, or is a check, is not reported', async () => {
  const { db, ow, sec, acct, invoice } = await world();
  await setWatchFrom('2026-01-01', ow, db);
  const inv = await invoice();
  const t = await createTransfer({ invoiceIds: [inv.id] }, sec, db);
  await approveTransfer(t.id, ow, db);
  await executeTransfer(t.id, { reference: 'ASM-77', paymentDate: '2026-06-01' }, sec, db);

  const debit = (date, amount, description, ref = null) =>
    db.run(
      `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
       VALUES (?, ?, ?, ?, ?, 'csv')`,
      [acct.id, date, amount, description, ref],
    );
  await debit('2026-06-03', -100000, 'העברה', 'ASM-77');   // ours — the אסמכתה we recorded
  await debit('2026-06-04', -70000, 'שיק 5001', '5001');   // a check — tracked on its own page
  await debit('2026-06-05', -90000, 'העברה לא מוכרת');      // the real problem

  const rows = await untrackedTransfers({ scope: null }, db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, 'העברה לא מוכרת');
});

test('each untracked movement is pushed once, not every night', async () => {
  const { db, ow, acct } = await world();
  await setWatchFrom('2026-01-01', ow, db);
  await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, source)
     VALUES (?, '2026-06-10', ?, 'העברה', 'csv')`,
    [acct.id, -300000],
  );
  assert.equal(await alertOnUntrackedTransfers(db), 1);
  assert.equal(await alertOnUntrackedTransfers(db), 0, 'idempotent — a quiet night says nothing');
});

test('a request raised after the money already moved is flagged as back-filled', () => {
  assert.equal(backfilled({ opened_at: '2026-06-12 09:00:00' }, '2026-06-10'), true);
  assert.equal(backfilled({ opened_at: '2026-06-09 09:00:00' }, '2026-06-10'), false);
  assert.equal(backfilled({ opened_at: '2026-06-10 23:00:00' }, '2026-06-10'), false, 'same day is fine');
});

// --- an approval must not outlive what it approved ------------------------------------------------
//
// An approval is a standing licence to release money in the bank. Three things can quietly make it
// wrong, and none of them involves anybody editing this request:
//   • it simply sits open for weeks (expired);
//   • the substance changes under it — most dangerously THE SUPPLIER'S BANK ACCOUNT (stale);
//   • the bank moves a different sum than the one approved (mismatch).
// All three are recomputed, never stored, so they cannot go out of date.

test('an approval lapses after the TTL, and executing on it is refused', async () => {
  const { db, ow, sec, invoice } = await world();
  const { config } = await import('../src/config.js');
  const { approvalExpired } = await import('../src/services/transfers.js');
  const t = await createTransfer({ invoiceIds: [(await invoice()).id] }, sec, db);
  await approveTransfer(t.id, ow, db);

  const fresh = await db.one('SELECT * FROM bank_transfers WHERE id = ?', [t.id]);
  assert.equal(approvalExpired(fresh), false);

  // Back-date the approval past the window.
  const old = new Date(Date.now() - (config.rules.transferApprovalTtlDays + 2) * 86400000);
  const stamp = `${old.toISOString().slice(0, 10)} ${old.toISOString().slice(11, 19)}`;
  await db.run('UPDATE bank_transfers SET approved_at = ? WHERE id = ?', [stamp, t.id]);

  const lapsed = await db.one('SELECT * FROM bank_transfers WHERE id = ?', [t.id]);
  assert.equal(approvalExpired(lapsed), true);
  await assert.rejects(() => executeTransfer(t.id, { reference: 'X' }, sec, db), /האישור פג/);

  const row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.displayStatus, 'expired');
  assert.equal(row.needsReapproval, true);

  // Re-approving is a fresh decision on today's facts, and unblocks it.
  await approveTransfer(t.id, ow, db);
  const done = await executeTransfer(t.id, { reference: 'OK-1', paymentDate: '2026-06-01' }, sec, db);
  assert.equal(done.status, 'executed');
});

test('🔴 changing the supplier bank account AFTER approval voids the approval', async () => {
  const { db, ow, sec, invoice } = await world();
  const { setSupplierBankAccount } = await import('../src/services/suppliers.js');
  const inv = await invoice();
  const t = await createTransfer({ invoiceIds: [inv.id] }, sec, db);
  await setSupplierBankAccount(inv.supplier_id, { bankCode: '12', bankBranch: '428', bankAccount: '111111' }, ow, db);
  await approveTransfer(t.id, ow, db);

  // Approved against account 111111. Somebody now "updates" it — the classic supplier-bank fraud.
  await setSupplierBankAccount(inv.supplier_id, { bankCode: '12', bankBranch: '428', bankAccount: '999999' }, ow, db);

  await assert.rejects(
    () => executeTransfer(t.id, { reference: 'X' }, sec, db),
    /השתנו אחרי האישור/,
    'the approval was of a different destination — it cannot carry over',
  );
  const row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.displayStatus, 'stale');
  assert.equal(row.needsReapproval, true);

  // Re-approving takes a fresh fingerprint of the CURRENT account, and then it may go.
  await approveTransfer(t.id, ow, db);
  const ok = await executeTransfer(t.id, { reference: 'OK-2', paymentDate: '2026-06-01' }, sec, db);
  assert.equal(ok.status, 'executed');
});

test('a request whose invoice set is unchanged stays approved — the check is not trigger-happy', async () => {
  const { db, ow, sec, invoice } = await world();
  const t = await createTransfer({ invoiceIds: [(await invoice()).id] }, sec, db);
  await approveTransfer(t.id, ow, db);
  const row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.displayStatus, 'approved');
  assert.equal(row.needsReapproval, false);
});

test('🔴 the bank moving a different sum than the one approved is flagged, not quietly cleared', async () => {
  const { db, ow, sec, acct, invoice } = await world();
  const inv = await invoice({ amount: 100000 });
  const t = await createTransfer({ invoiceIds: [inv.id] }, sec, db);
  await approveTransfer(t.id, ow, db);
  await executeTransfer(t.id, { reference: 'ASM-9', paymentDate: '2026-06-01' }, sec, db);
  const paymentId = (await db.one('SELECT payment_id FROM bank_transfers WHERE id = ?', [t.id])).payment_id;

  // The bank paid ₪950 against a ₪1,000 request — a partial release, or a fee at source.
  await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, source, matched_payment_id)
     VALUES (?, '2026-06-02', ?, 'העברה', 'csv', ?)`,
    [acct.id, -95000, paymentId],
  );
  await db.run("UPDATE payments SET status = 'cleared' WHERE id = ?", [paymentId]);

  const row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.amountMismatch, true);
  assert.equal(row.displayStatus, 'mismatch', 'the mismatch outranks "נפרע" — it needs a human');
  assert.equal(row.bankAmount, -95000);
});

test('the exact amount clears normally — no false alarm', async () => {
  const { db, ow, sec, acct, invoice } = await world();
  const inv = await invoice({ amount: 100000 });
  const t = await createTransfer({ invoiceIds: [inv.id] }, sec, db);
  await approveTransfer(t.id, ow, db);
  await executeTransfer(t.id, { reference: 'ASM-10', paymentDate: '2026-06-01' }, sec, db);
  const paymentId = (await db.one('SELECT payment_id FROM bank_transfers WHERE id = ?', [t.id])).payment_id;
  const amount = (await db.one('SELECT amount FROM bank_transfers WHERE id = ?', [t.id])).amount;

  await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, source, matched_payment_id)
     VALUES (?, '2026-06-02', ?, 'העברה', 'csv', ?)`,
    [acct.id, -amount, paymentId],
  );
  await db.run("UPDATE payments SET status = 'cleared' WHERE id = ?", [paymentId]);

  const row = (await listTransfers({ scope: null }, db))[0];
  assert.equal(row.amountMismatch, false);
  assert.equal(row.displayStatus, 'cleared');
});

test('each problem is pushed once, and re-approval re-arms the alert', async () => {
  const { db, ow, sec, invoice } = await world();
  const { alertOnTransferProblems } = await import('../src/services/transfers.js');
  const { config } = await import('../src/config.js');
  const t = await createTransfer({ invoiceIds: [(await invoice()).id] }, sec, db);
  await approveTransfer(t.id, ow, db);
  const old = new Date(Date.now() - (config.rules.transferApprovalTtlDays + 2) * 86400000);
  await db.run('UPDATE bank_transfers SET approved_at = ? WHERE id = ?',
    [`${old.toISOString().slice(0, 10)} ${old.toISOString().slice(11, 19)}`, t.id]);

  assert.equal(await alertOnTransferProblems(db), 1);
  assert.equal(await alertOnTransferProblems(db), 0, 'idempotent — a quiet night says nothing');

  // Re-approving clears the marker, so a NEW problem on the same request can still be reported.
  await approveTransfer(t.id, ow, db);
  assert.equal((await db.one('SELECT alerted FROM bank_transfers WHERE id = ?', [t.id])).alerted, null);
});

test('🔴 the fingerprint follows the account the STORE actually pays from', async () => {
  const { db, ow, sec, store, invoice } = await world();
  const { setSupplierBankAccount } = await import('../src/services/suppliers.js');
  const inv = await invoice({ amount: 120000 });
  // A default account and a different one for this store. The store's is the one that pays.
  await setSupplierBankAccount(inv.supplier_id, { bankCode: '12', bankBranch: '428', bankAccount: '111111' }, ow, db);
  await setSupplierBankAccount(inv.supplier_id, { storeId: store.id, bankCode: '10', bankBranch: '900', bankAccount: '222222' }, ow, db);

  const t = await createTransfer({ invoiceIds: [inv.id] }, sec, db);
  let row = (await listTransfers({ scope: null }, db)).find((r) => Number(r.id) === Number(t.id));
  assert.equal(row.bank.bank_account, '222222', 'the store account, not the supplier default');
  assert.equal(row.bankForStore, true);

  await approveTransfer(t.id, ow, db);
  // Changing the DEFAULT account must not disturb an approval that pays from the store account.
  await setSupplierBankAccount(inv.supplier_id, { bankCode: '12', bankBranch: '428', bankAccount: '333333' }, ow, db);
  row = (await listTransfers({ scope: null }, db)).find((r) => Number(r.id) === Number(t.id));
  assert.equal(row.needsReapproval, false, 'a change to an account this transfer does not use is not a change');

  // Changing only the BANK CODE of the paying account is a destination change and voids it.
  await setSupplierBankAccount(inv.supplier_id, { storeId: store.id, bankCode: '20', bankBranch: '900', bankAccount: '222222' }, ow, db);
  row = (await listTransfers({ scope: null }, db)).find((r) => Number(r.id) === Number(t.id));
  assert.equal(row.displayStatus, 'stale', 'a different bank with the same account number is a different destination');
  await assert.rejects(() => executeTransfer(t.id, { reference: 'Z9' }, ow, db), /השתנו אחרי האישור/);
});
