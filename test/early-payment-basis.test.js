// End-to-end: the "תשלום מוקדם מתנאי התשלום" alert must anchor on the TAX invoice (the earliest
// one when several are netted), never on the credit note that rides along on the same payment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { listNotifications } from '../src/services/notifications.js';

test('createPayment alerts from the earliest tax invoice, ignoring the credit note', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status, payment_terms) VALUES ('קוקה קולה', 'approved', 'שוטף 30')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='קוקה קולה'", []);

  const mk = (num, date, before, vat, docType) =>
    createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: num, invoiceDate: date, amountBeforeVat: before, vatAmount: vat, docType }, ow, db);
  await mk('T-100', '2026-01-05', 10000, 1700, 'tax_invoice');   // earliest tax invoice → the basis
  await mk('T-200', '2026-01-18', 5000, 850, 'tax_invoice');
  await mk('C-900', '2026-01-02', -2000, -340, 'credit_note');   // earlier, but must be ignored

  const ids = (await db.many('SELECT id FROM invoices WHERE supplier_id = ? ORDER BY id', [sup.id])).map((r) => r.id);
  await createPayment(
    { bankAccountId: ba.id, method: 'check', checkNumber: '7001', paymentDate: '2026-01-25', invoiceIds: ids },
    ow, db,
  );

  // notify() persists on a fire-and-forget microtask — let it settle.
  await new Promise((r) => setTimeout(r, 40));
  const early = (await listNotifications({ limit: 20 }, db)).filter((n) => /תשלום מוקדם/.test(n.title));
  assert.equal(early.length, 1, 'one early-payment alert');
  const body = early[0].body;
  assert.match(body, /T-100/, 'anchored on the earliest tax invoice');
  assert.ok(!body.includes('C-900'), 'the credit note is never the basis');
  assert.ok(!body.includes('T-200'), 'one alert per supplier, not one per invoice');
  assert.match(body, /20 ימים/); // Jan 5 → Jan 25
  assert.match(body, /מוקדם ב-10 ימים/); // terms 30 − 20
});
