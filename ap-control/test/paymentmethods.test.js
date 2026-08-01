import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { migrate } from '../src/db/migrate.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { autoReconcile } from '../src/services/reconciliation.js';
import { toAgorot } from '../src/lib/money.js';

let seq = 0;
function approvedInvoice(db, amountShekels = '100') {
  seq += 1;
  const st = firstStore(db);
  const sec = secretary(db);
  const acct = db.prepare('SELECT id FROM bank_accounts WHERE store_id=?').get(st.id).id;
  const sup = approveSupplier(createSupplier({ name: `ספק ${seq}` }, sec, db).id, owner(db), db);
  const { invoice } = createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: `PM${seq}`, invoiceDate: '2026-07-01', amountBeforeVat: toAgorot(amountShekels), vatAmount: 0, docType: 'tax_invoice' },
    sec,
    db,
  );
  approveInvoiceForPayment(invoice.id, sec, db);
  return { acct, invoiceId: invoice.id, sec };
}

test('migration rebuilds an old payments table (adds method, keeps rows)', () => {
  const db = freshDb();
  db.pragma('foreign_keys = OFF');
  db.exec('DROP TABLE payments');
  db.exec(`CREATE TABLE payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_account_id INTEGER NOT NULL REFERENCES bank_accounts(id),
    check_number TEXT NOT NULL,
    payment_date TEXT NOT NULL,
    amount INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'issued',
    cleared_date TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT
  )`);
  db.pragma('foreign_keys = ON');
  const acct = db.prepare('SELECT id FROM bank_accounts LIMIT 1').get().id;
  const uid = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare('INSERT INTO payments (bank_account_id,check_number,payment_date,amount,status,created_by) VALUES (?,?,?,?,?,?)')
    .run(acct, '9001', '2026-07-01', 10000, 'issued', uid);

  migrate(db);

  const cols = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
  assert.ok(cols.includes('method') && cols.includes('reference') && cols.includes('card_last4'));
  const row = db.prepare("SELECT * FROM payments WHERE check_number='9001'").get();
  assert.equal(row.method, 'check');
  assert.equal(row.amount, 10000);
});

test('cash payment: payer name required', () => {
  const db = freshDb();
  const { acct, invoiceId, sec } = approvedInvoice(db);
  assert.throws(
    () => createPayment({ bankAccountId: acct, method: 'cash', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db),
    /שם המשלם/,
  );
  const p = createPayment({ bankAccountId: acct, method: 'cash', payerName: 'דני', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db);
  assert.equal(p.method, 'cash');
  assert.equal(p.payer_name, 'דני');
});

test('credit payment: 4-digit card required', () => {
  const db = freshDb();
  const { acct, invoiceId, sec } = approvedInvoice(db);
  assert.throws(
    () => createPayment({ bankAccountId: acct, method: 'credit', cardLast4: '12', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db),
    /4 ספרות/,
  );
  const p = createPayment({ bankAccountId: acct, method: 'credit', cardLast4: '4321', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db);
  assert.equal(p.card_last4, '4321');
});

test('transfer payment requires a reference and can be auto-reconciled by it', () => {
  const db = freshDb();
  const { acct, invoiceId, sec } = approvedInvoice(db, '188.80'); // 18880 agorot, no VAT
  assert.throws(
    () => createPayment({ bankAccountId: acct, method: 'transfer', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db),
    /אסמכתא/,
  );
  const p = createPayment({ bankAccountId: acct, method: 'transfer', reference: '473018585', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db);
  assert.equal(p.method, 'transfer');
  assert.equal(p.amount, toAgorot('188.80'));

  // bank debit for the transfer (reference matches) -> deterministic auto-match
  importTransactions(acct, [{ txnDate: '2026-07-03', amount: -toAgorot('188.80'), description: 'העברה לאחר', rawReference: '473018585' }], 'csv', sec, db);
  const res = autoReconcile(acct, sec, db);
  assert.equal(res.matched, 1);
  assert.equal(db.prepare('SELECT status FROM payments WHERE id=?').get(p.id).status, 'cleared');
});

test('batch payment requires batch number and reference', () => {
  const db = freshDb();
  const { acct, invoiceId, sec } = approvedInvoice(db);
  assert.throws(
    () => createPayment({ bankAccountId: acct, method: 'batch', reference: '179889097', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db),
    /מספר מקבץ/,
  );
  const p = createPayment({ bankAccountId: acct, method: 'batch', batchNumber: 'MK-1', reference: '179889097', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db);
  assert.equal(p.method, 'batch');
  assert.equal(p.batch_number, 'MK-1');
  assert.equal(p.reference, '179889097');
});

test('R1 still enforced for non-check methods (unapproved invoice blocks a cash payment)', () => {
  const db = freshDb();
  const st = firstStore(db);
  const sec = secretary(db);
  const acct = db.prepare('SELECT id FROM bank_accounts WHERE store_id=?').get(st.id).id;
  const sup = approveSupplier(createSupplier({ name: 'ספק R1' }, sec, db).id, owner(db), db);
  const { invoice } = createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'R1x', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('50'), vatAmount: 0, docType: 'tax_invoice' },
    sec,
    db,
  ); // NOT approved for payment
  assert.throws(
    () => createPayment({ bankAccountId: acct, method: 'cash', payerName: 'x', paymentDate: '2026-07-02', invoiceIds: [invoice.id] }, sec, db),
    /approved_for_payment/,
  );
});
