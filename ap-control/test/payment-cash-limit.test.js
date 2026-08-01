import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { toAgorot } from '../src/lib/money.js';
import { config } from '../src/config.js';

async function setup(amountShekel) {
  const db = await freshDb();
  const st = await firstStore(db);
  const sec = await secretary(db);
  const acct = await accountForStore(db, st.id);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק' }, sec, db)).id, await owner(db), db);
  const { invoice } = await createInvoice(
    // allocation number set so a large amount doesn't trip R3 (on_hold) — we're testing the cash cap.
    { supplierId: sup.id, storeId: st.id, invoiceNumber: 'C1', allocationNumber: '123456789', invoiceDate: '2026-07-01', amountBeforeVat: toAgorot(amountShekel), vatAmount: 0, docType: 'tax_invoice' },
    sec, db,
  );
  return { db, sec, acct, invoice };
}

test('cash payment over the legal ceiling is blocked; other methods allowed', async () => {
  const over = config.cashCeilingAgorot / 100 + 1000;
  const { db, sec, acct, invoice } = await setup(String(over));
  await assert.rejects(
    createPayment({ bankAccountId: acct.id, method: 'cash', payerName: 'יניב', paymentDate: '2026-07-02', invoiceIds: [invoice.id] }, sec, db),
    /חוק צמצום השימוש במזומן/,
  );
  // transfer of the same amount is fine
  const p = await createPayment({ bankAccountId: acct.id, method: 'transfer', reference: 'REF1', paymentDate: '2026-07-02', invoiceIds: [invoice.id] }, sec, db);
  assert.equal(p.status, 'issued');
});

test('paying a recorded (un-approved) invoice works — payment implies approval', async () => {
  const { db, sec, acct, invoice } = await setup('100');
  assert.equal(invoice.status, 'recorded');
  const p = await createPayment({ bankAccountId: acct.id, method: 'cash', payerName: 'יניב', paymentDate: '2026-07-02', invoiceIds: [invoice.id] }, sec, db);
  assert.equal(p.status, 'issued');
  assert.equal((await db.one('SELECT status FROM invoices WHERE id = ?', [invoice.id])).status, 'paid');
});
