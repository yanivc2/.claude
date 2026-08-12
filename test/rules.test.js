import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import {
  createInvoice,
  approveInvoiceForPayment,
  setAllocationNumber,
} from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { outstandingChecks } from '../src/services/reports.js';
import { toAgorot } from '../src/lib/money.js';

function baseInvoice(db, supplierId, storeId, over) {
  return {
    supplierId,
    storeId,
    invoiceNumber: 'INV-1',
    invoiceDate: '2026-07-01',
    amountBeforeVat: toAgorot('1000'),
    vatAmount: toAgorot('170'),
    docType: 'tax_invoice',
    ...over,
  };
}

test('seed creates 4 companies, 4 stores, 4 accounts (1:1)', async () => {
  const db = await freshDb();
  assert.equal((await db.one('SELECT COUNT(*) n FROM companies', [])).n, 4);
  assert.equal((await db.one('SELECT COUNT(*) n FROM stores', [])).n, 4);
  assert.equal((await db.one('SELECT COUNT(*) n FROM bank_accounts', [])).n, 4);
});

test('R6: only owner can approve a supplier', async () => {
  const db = await freshDb();
  const sec = await secretary(db);
  const sup = await createSupplier({ name: 'ספק א' }, sec, db);
  assert.equal(sup.status, 'pending');
  await assert.rejects(approveSupplier(sup.id, sec, db), /הרשאת ניהול ספקים/);
  const approved = await approveSupplier(sup.id, await owner(db), db);
  assert.equal(approved.status, 'approved');
});

test('R2 primary: duplicate allocation_number is hard-blocked', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const sup = await createSupplier({ name: 'ספק' }, sec, db);
  await createInvoice(baseInvoice(db, sup.id, st.id, { allocationNumber: '123456789' }), sec, db);
  await assert.rejects(
    createInvoice(
      baseInvoice(db, sup.id, st.id, { invoiceNumber: 'INV-2', allocationNumber: '123456789' }),
      sec,
      db,
    ),
    /כפילות חסומה/,
  );
});

test('R2 secondary: same supplier+number returns a soft warning needing confirmation', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const sup = await createSupplier({ name: 'ספק' }, sec, db);
  await createInvoice(baseInvoice(db, sup.id, st.id, {}), sec, db);
  try {
    await createInvoice(baseInvoice(db, sup.id, st.id, {}), sec, db);
    assert.fail('expected a warning');
  } catch (err) {
    assert.equal(err.meta?.needsConfirmation, true);
    assert.ok(err.meta.warnings.some((w) => w.code === 'R2'));
  }
  const { invoice } = await createInvoice(
    baseInvoice(db, sup.id, st.id, { confirm: true, confirmReason: 'חוזרת חודשית' }),
    sec,
    db,
  );
  assert.ok(invoice.id);
});

test('R3: tax invoice over 5000 without allocation -> on_hold, released by owner or allocation', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, await owner(db), db);
  const { invoice } = await createInvoice(
    baseInvoice(db, sup.id, st.id, { amountBeforeVat: toAgorot('6000'), vatAmount: toAgorot('1020') }),
    sec,
    db,
  );
  assert.equal(invoice.status, 'on_hold');
  await assert.rejects(approveInvoiceForPayment(invoice.id, sec, db), /הרשאת החזקת חשבונית/);
  const released = await approveInvoiceForPayment(invoice.id, await owner(db), db);
  assert.equal(released.status, 'approved_for_payment');
});

test('R3 resolved by adding an allocation number clears the hold', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const sup = await createSupplier({ name: 'ספק' }, sec, db);
  const { invoice } = await createInvoice(
    baseInvoice(db, sup.id, st.id, { amountBeforeVat: toAgorot('6000') }),
    sec,
    db,
  );
  assert.equal(invoice.status, 'on_hold');
  const fixed = await setAllocationNumber(invoice.id, '987654321', sec, db);
  assert.equal(fixed.status, 'recorded');
  assert.equal(fixed.allocation_number, '987654321');
});

test('credit note is stored negative and exempt from R3 allocation', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const sup = await createSupplier({ name: 'ספק' }, sec, db);
  const { invoice } = await createInvoice(
    baseInvoice(db, sup.id, st.id, {
      docType: 'credit_note',
      amountBeforeVat: toAgorot('6000'),
      vatAmount: toAgorot('1020'),
    }),
    sec,
    db,
  );
  assert.equal(invoice.status, 'recorded');
  assert.ok(invoice.total_amount < 0);
});

test('R1: cannot issue a check for an unapproved supplier', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const sup = await createSupplier({ name: 'ספק' }, sec, db); // pending — never approved
  const { invoice } = await createInvoice(baseInvoice(db, sup.id, st.id, {}), sec, db);

  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  await assert.rejects(
    createPayment(
      { bankAccountId: acct, checkNumber: '1001', paymentDate: '2026-07-10', invoiceIds: [invoice.id] },
      sec,
      db,
    ),
    /אינו מאושר/,
  );
});

test('check-blocking: no check without a check number and without invoices', async () => {
  const db = await freshDb();
  const sec = await secretary(db);
  const acct = (await db.one('SELECT id FROM bank_accounts LIMIT 1', [])).id;
  await assert.rejects(
    createPayment({ bankAccountId: acct, checkNumber: '', paymentDate: '2026-07-10', invoiceIds: [1] }, sec, db),
    /ללא מספר צ׳ק/,
  );
  await assert.rejects(
    createPayment({ bankAccountId: acct, checkNumber: '1', paymentDate: '2026-07-10', invoiceIds: [] }, sec, db),
    /ללא חשבונית/,
  );
});

test('R5 + happy path: check total equals net of invoices minus credits; outstanding report reflects it', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, await owner(db), db);

  const { invoice: inv } = await createInvoice(
    baseInvoice(db, sup.id, st.id, { invoiceNumber: 'A', amountBeforeVat: toAgorot('1000'), vatAmount: toAgorot('170') }),
    sec,
    db,
  );
  const { invoice: credit } = await createInvoice(
    baseInvoice(db, sup.id, st.id, {
      invoiceNumber: 'C',
      docType: 'credit_note',
      amountBeforeVat: toAgorot('100'),
      vatAmount: toAgorot('17'),
    }),
    sec,
    db,
  );

  await approveInvoiceForPayment(inv.id, sec, db);
  await approveInvoiceForPayment(credit.id, sec, db);

  const payment = await createPayment(
    { bankAccountId: acct, checkNumber: '2001', paymentDate: '2026-07-11', invoiceIds: [inv.id, credit.id] },
    sec,
    db,
  );
  assert.equal(payment.amount, 105300);
  const lineSum = payment.lines.reduce((s, l) => s + l.amount_applied, 0);
  assert.equal(lineSum, payment.amount); // R5

  assert.equal((await db.one('SELECT status FROM invoices WHERE id=?', [inv.id])).status, 'paid');

  const { totalOutstanding } = await outstandingChecks(null, db);
  assert.equal(totalOutstanding, 105300);
});

test('checks on one payment must all belong to the same bank account', async () => {
  const db = await freshDb();
  const sec = await secretary(db);
  const stores = await db.many('SELECT * FROM stores ORDER BY id LIMIT 2', []);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, await owner(db), db);
  const acct0 = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [stores[0].id])).id;

  const { invoice: i0 } = await createInvoice(
    baseInvoice(db, sup.id, stores[0].id, { invoiceNumber: 'S0', amountBeforeVat: toAgorot('1000') }),
    sec,
    db,
  );
  const { invoice: i1 } = await createInvoice(
    baseInvoice(db, sup.id, stores[1].id, { invoiceNumber: 'S1', amountBeforeVat: toAgorot('2000') }),
    sec,
    db,
  );
  await approveInvoiceForPayment(i0.id, sec, db);
  await approveInvoiceForPayment(i1.id, sec, db);

  await assert.rejects(
    createPayment(
      { bankAccountId: acct0, checkNumber: '3001', paymentDate: '2026-07-12', invoiceIds: [i0.id, i1.id] },
      sec,
      db,
    ),
    /חשבון בנק אחר/,
  );
});
