import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { migrate } from '../src/db/migrate.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { autoReconcile } from '../src/services/reconciliation.js';
import { toAgorot } from '../src/lib/money.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let seq = 0;
async function approvedInvoice(db, amountShekels = '100') {
  seq += 1;
  const st = await firstStore(db);
  const sec = await secretary(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: `ספק ${seq}` }, sec, db)).id, await owner(db), db);
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: `PM${seq}`, invoiceDate: '2026-07-01', amountBeforeVat: toAgorot(amountShekels), vatAmount: 0, docType: 'tax_invoice' },
    sec,
    db,
  );
  await approveInvoiceForPayment(invoice.id, sec, db);
  return { acct, invoiceId: invoice.id, sec };
}

test('migration rebuilds an old payments table (adds method, keeps rows)', () => {
  // SQLite-only migration path — run it on a raw better-sqlite3 handle.
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
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
  db.exec("INSERT INTO companies (name) VALUES ('C')");
  db.exec("INSERT INTO users (name, role) VALUES ('U','owner')");
  db.exec("INSERT INTO stores (company_id, name) VALUES (1,'S')");
  db.exec("INSERT INTO bank_accounts (company_id, store_id, branch, account_number, display_name) VALUES (1,1,'428','1','A')");
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

test('cash payment: payer name required', async () => {
  const db = await freshDb();
  const { acct, invoiceId, sec } = await approvedInvoice(db);
  await assert.rejects(
    createPayment({ bankAccountId: acct, method: 'cash', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db),
    /שם המשלם/,
  );
  const p = await createPayment({ bankAccountId: acct, method: 'cash', payerName: 'דני', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db);
  assert.equal(p.method, 'cash');
  assert.equal(p.payer_name, 'דני');
});

test('credit payment: 4-digit card required', async () => {
  const db = await freshDb();
  const { acct, invoiceId, sec } = await approvedInvoice(db);
  await assert.rejects(
    createPayment({ bankAccountId: acct, method: 'credit', cardLast4: '12', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db),
    /4 ספרות/,
  );
  const p = await createPayment({ bankAccountId: acct, method: 'credit', cardLast4: '4321', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db);
  assert.equal(p.card_last4, '4321');
});

test('transfer payment requires a reference and can be auto-reconciled by it', async () => {
  const db = await freshDb();
  const { acct, invoiceId, sec } = await approvedInvoice(db, '188.80'); // 18880 agorot, no VAT
  await assert.rejects(
    createPayment({ bankAccountId: acct, method: 'transfer', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db),
    /אסמכתא/,
  );
  const p = await createPayment({ bankAccountId: acct, method: 'transfer', reference: '473018585', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db);
  assert.equal(p.method, 'transfer');
  assert.equal(p.amount, toAgorot('188.80'));

  await importTransactions(acct, [{ txnDate: '2026-07-03', amount: -toAgorot('188.80'), description: 'העברה לאחר', rawReference: '473018585' }], 'csv', sec, db);
  const res = await autoReconcile(acct, sec, db);
  assert.equal(res.matched, 1);
  assert.equal((await db.one('SELECT status FROM payments WHERE id=?', [p.id])).status, 'cleared');
});

test('batch payment requires batch number and reference', async () => {
  const db = await freshDb();
  const { acct, invoiceId, sec } = await approvedInvoice(db);
  await assert.rejects(
    createPayment({ bankAccountId: acct, method: 'batch', reference: '179889097', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db),
    /מספר מקבץ/,
  );
  const p = await createPayment({ bankAccountId: acct, method: 'batch', batchNumber: 'MK-1', reference: '179889097', paymentDate: '2026-07-02', invoiceIds: [invoiceId] }, sec, db);
  assert.equal(p.method, 'batch');
  assert.equal(p.batch_number, 'MK-1');
  assert.equal(p.reference, '179889097');
});

test('an on_hold (R3) invoice is blocked from payment; a recorded one is payable', async () => {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id=?', [st.id])).id;
  const sup = await approveSupplier((await createSupplier({ name: 'ספק R1' }, sec, db)).id, await owner(db), db);
  // Tax invoice over the allocation threshold with no allocation number -> auto on_hold (R3).
  const { invoice } = await createInvoice(
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'R1x', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot('9000'), vatAmount: 0, docType: 'tax_invoice' },
    sec,
    db,
  );
  assert.equal(invoice.status, 'on_hold');
  await assert.rejects(
    createPayment({ bankAccountId: acct, method: 'transfer', reference: 'r1', paymentDate: '2026-07-02', invoiceIds: [invoice.id] }, sec, db),
    /מוחזקת|R3/,
  );
});
