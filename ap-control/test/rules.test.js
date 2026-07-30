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

test('seed creates 3 companies, 4 stores, 4 accounts (1:1)', () => {
  const db = freshDb();
  assert.equal(db.prepare('SELECT COUNT(*) n FROM companies').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM stores').get().n, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM bank_accounts').get().n, 4);
});

test('R6: only owner can approve a supplier', () => {
  const db = freshDb();
  const sec = secretary(db);
  const sup = createSupplier({ name: 'ספק א' }, sec, db);
  assert.equal(sup.status, 'pending');
  assert.throws(() => approveSupplier(sup.id, sec, db), /בעלים בלבד/);
  const approved = approveSupplier(sup.id, owner(db), db);
  assert.equal(approved.status, 'approved');
});

test('R2 primary: duplicate allocation_number is hard-blocked', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sup = createSupplier({ name: 'ספק' }, secretary(db), db);
  createInvoice(baseInvoice(db, sup.id, st.id, { allocationNumber: '123456789' }), secretary(db), db);
  assert.throws(
    () =>
      createInvoice(
        baseInvoice(db, sup.id, st.id, { invoiceNumber: 'INV-2', allocationNumber: '123456789' }),
        secretary(db),
        db,
      ),
    /כפילות חסומה/,
  );
});

test('R2 secondary: same supplier+number returns a soft warning needing confirmation', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sup = createSupplier({ name: 'ספק' }, secretary(db), db);
  createInvoice(baseInvoice(db, sup.id, st.id, {}), secretary(db), db);
  try {
    createInvoice(baseInvoice(db, sup.id, st.id, {}), secretary(db), db);
    assert.fail('expected a warning');
  } catch (err) {
    assert.equal(err.meta?.needsConfirmation, true);
    assert.ok(err.meta.warnings.some((w) => w.code === 'R2'));
  }
  // With confirm, it proceeds.
  const { invoice } = createInvoice(
    baseInvoice(db, sup.id, st.id, { confirm: true, confirmReason: 'חוזרת חודשית' }),
    secretary(db),
    db,
  );
  assert.ok(invoice.id);
});

test('R3: tax invoice over 5000 without allocation -> on_hold, released by owner or allocation', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sup = approveSupplier(createSupplier({ name: 'ספק' }, secretary(db), db).id, owner(db), db);
  const { invoice } = createInvoice(
    baseInvoice(db, sup.id, st.id, { amountBeforeVat: toAgorot('6000'), vatAmount: toAgorot('1020') }),
    secretary(db),
    db,
  );
  assert.equal(invoice.status, 'on_hold');
  // Secretary cannot release an on_hold invoice (R6).
  assert.throws(() => approveInvoiceForPayment(invoice.id, secretary(db), db), /בעלים בלבד/);
  // Owner override works.
  const released = approveInvoiceForPayment(invoice.id, owner(db), db);
  assert.equal(released.status, 'approved_for_payment');
});

test('R3 resolved by adding an allocation number clears the hold', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sup = createSupplier({ name: 'ספק' }, secretary(db), db);
  const { invoice } = createInvoice(
    baseInvoice(db, sup.id, st.id, { amountBeforeVat: toAgorot('6000') }),
    secretary(db),
    db,
  );
  assert.equal(invoice.status, 'on_hold');
  const fixed = setAllocationNumber(invoice.id, '987654321', secretary(db), db);
  assert.equal(fixed.status, 'recorded');
  assert.equal(fixed.allocation_number, '987654321');
});

test('credit note is stored negative and exempt from R3 allocation', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sup = createSupplier({ name: 'ספק' }, secretary(db), db);
  const { invoice } = createInvoice(
    baseInvoice(db, sup.id, st.id, {
      docType: 'credit_note',
      amountBeforeVat: toAgorot('6000'),
      vatAmount: toAgorot('1020'),
    }),
    secretary(db),
    db,
  );
  assert.equal(invoice.status, 'recorded'); // not on_hold
  assert.ok(invoice.total_amount < 0);
});

test('R1: cannot issue a check for an unapproved-supplier or unapproved invoice', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sec = secretary(db);
  const sup = createSupplier({ name: 'ספק' }, sec, db); // pending
  const { invoice } = createInvoice(baseInvoice(db, sup.id, st.id, {}), sec, db);

  // supplier pending -> even approving invoice, R1 blocks on supplier status
  approveSupplier(sup.id, owner(db), db);
  // invoice still only 'recorded' -> R1 blocks
  assert.throws(
    () =>
      createPayment(
        {
          bankAccountId: db.prepare('SELECT id FROM bank_accounts WHERE store_id=?').get(st.id).id,
          checkNumber: '1001',
          paymentDate: '2026-07-10',
          invoiceIds: [invoice.id],
        },
        sec,
        db,
      ),
    /approved_for_payment/,
  );
});

test('check-blocking: no check without a check number and without invoices', () => {
  const db = freshDb();
  const sec = secretary(db);
  const acct = db.prepare('SELECT id FROM bank_accounts LIMIT 1').get().id;
  assert.throws(
    () => createPayment({ bankAccountId: acct, checkNumber: '', paymentDate: '2026-07-10', invoiceIds: [1] }, sec, db),
    /ללא מספר צ׳ק/,
  );
  assert.throws(
    () => createPayment({ bankAccountId: acct, checkNumber: '1', paymentDate: '2026-07-10', invoiceIds: [] }, sec, db),
    /ללא חשבונית/,
  );
});

test('R5 + happy path: check total equals net of invoices minus credits; outstanding report reflects it', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sec = secretary(db);
  const acct = db.prepare('SELECT id FROM bank_accounts WHERE store_id=?').get(st.id).id;
  const sup = approveSupplier(createSupplier({ name: 'ספק' }, sec, db).id, owner(db), db);

  const inv = createInvoice(
    baseInvoice(db, sup.id, st.id, { invoiceNumber: 'A', amountBeforeVat: toAgorot('1000'), vatAmount: toAgorot('170') }),
    sec,
    db,
  ).invoice;
  const credit = createInvoice(
    baseInvoice(db, sup.id, st.id, {
      invoiceNumber: 'C',
      docType: 'credit_note',
      amountBeforeVat: toAgorot('100'),
      vatAmount: toAgorot('17'),
    }),
    sec,
    db,
  ).invoice;

  approveInvoiceForPayment(inv.id, sec, db);
  approveInvoiceForPayment(credit.id, sec, db);

  const payment = createPayment(
    { bankAccountId: acct, checkNumber: '2001', paymentDate: '2026-07-11', invoiceIds: [inv.id, credit.id] },
    sec,
    db,
  );
  // 1170 - 117 = 1053 ILS => 105300 agorot
  assert.equal(payment.amount, 105300);
  const lineSum = payment.lines.reduce((s, l) => s + l.amount_applied, 0);
  assert.equal(lineSum, payment.amount); // R5

  // both invoices now paid
  assert.equal(db.prepare('SELECT status FROM invoices WHERE id=?').get(inv.id).status, 'paid');

  const { totalOutstanding } = outstandingChecks(db);
  assert.equal(totalOutstanding, 105300);
});

test('checks on one payment must all belong to the same bank account', () => {
  const db = freshDb();
  const sec = secretary(db);
  const stores = db.prepare('SELECT * FROM stores ORDER BY id LIMIT 2').all();
  const sup = approveSupplier(createSupplier({ name: 'ספק' }, sec, db).id, owner(db), db);
  const acct0 = db.prepare('SELECT id FROM bank_accounts WHERE store_id=?').get(stores[0].id).id;

  const i0 = createInvoice(
    baseInvoice(db, sup.id, stores[0].id, { invoiceNumber: 'S0', amountBeforeVat: toAgorot('1000') }),
    sec,
    db,
  ).invoice;
  const i1 = createInvoice(
    baseInvoice(db, sup.id, stores[1].id, { invoiceNumber: 'S1', amountBeforeVat: toAgorot('2000') }),
    sec,
    db,
  ).invoice;
  approveInvoiceForPayment(i0.id, sec, db);
  approveInvoiceForPayment(i1.id, sec, db);

  assert.throws(
    () =>
      createPayment(
        { bankAccountId: acct0, checkNumber: '3001', paymentDate: '2026-07-12', invoiceIds: [i0.id, i1.id] },
        sec,
        db,
      ),
    /חשבון בנק אחר/,
  );
});
