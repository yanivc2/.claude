import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { getPaymentDetail } from '../src/services/payments.js';

// After "שמור והוסף עוד לספק", the batch-payment section on the new-invoice screen must pre-select
// every invoice/credit already entered for that supplier+store, so one payment nets them together.
let server, base, db, sup, st;
const cookieFor = (u) => `session=${createSession(u.id)}`;

before(async () => {
  db = await freshDb();
  const own = await owner(db);
  st = await firstStore(db);
  sup = await approveSupplier((await createSupplier({ name: 'ספק אצווה' }, own, db)).id, own, db);
  await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'BP1', invoiceDate: '2026-08-01', amountBeforeVat: 10000, vatAmount: 1700, docType: 'tax_invoice' }, own, db);
  await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'BP2', invoiceDate: '2026-08-02', amountBeforeVat: -4000, vatAmount: -680, docType: 'credit_note' }, own, db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('add_another pre-checks every entered invoice/credit in the batch-payment section', async () => {
  const res = await fetch(`${base}/invoices/new?supplier=${sup.id}&store=${st.id}&added=1`, {
    headers: { cookie: cookieFor(await owner(db)) },
  });
  const html = await res.text();
  const checked = (html.match(/class="bp-check"[^>]*checked/g) || []).length;
  assert.equal(checked, 2, 'both the invoice and the credit are pre-checked');
});

test('pay-batch nets the entered invoices into one payment (R5)', async () => {
  const invs = await db.many('SELECT id FROM invoices WHERE supplier_id = ? ORDER BY id', [sup.id]);
  const body = new URLSearchParams();
  body.append('supplier_id', String(sup.id));
  body.append('store_id', String(st.id));
  for (const iv of invs) body.append('invoice_ids', String(iv.id));
  body.append('pay_method', 'check');
  body.append('check_number', '4242');
  body.append('check_due_date', '2026-08-10');
  const res = await fetch(`${base}/invoices/pay-batch`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookieFor(await owner(db)), 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  const pid = Number(loc.split('/').pop());
  const pay = await getPaymentDetail(pid, db);
  // net = (10000+1700) − (4000+680) = 7020 agorot
  assert.equal(pay.amount, 7020);
  assert.equal(pay.lines.length, 2);
});
