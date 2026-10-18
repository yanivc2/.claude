// בעלים, 17/10: "בדף חשבוניות, סדר את העמודות מימין לשמאל: חנות, ספק, מספר חשבונית, תאריך חשבונית
// (לוודא שזה תאריך החשבונית ולא תאריך תשלום), אמצעי תשלום, מספר אסמכתא, תאריך לתשלום, סכום לתשלום.
// במקום 'שולם' — סטטוס."
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { toAgorot } from '../src/lib/money.js';

let db, ow, store, server, base;
before(async () => {
  db = await freshDb();
  ow = await owner(db);
  store = await firstStore(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const cellsOf = (html, marker) => {
  const tr = html.split('<tr').find((t) => t.includes(marker));
  return [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/&#39;/g, "'").replace(/&#34;/g, '"').replace(/&amp;/g, '&'));
};

test('column order (right → left) and "סטטוס" instead of "שולם"', async () => {
  const html = await (await fetch(`${base}/invoices`, { headers: { cookie: `session=${createSession(ow.id)}; ap_store=${store.id}` } })).text();
  // "✓" is also the "only what can be picked" filter (owner, 18/10) — its own attributes don't matter here.
  const head = html.match(/<tr><th class="no-print pick-head"[^>]*>✓<\/th>([\s\S]*?)<\/tr>/)[1];
  const names = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
  assert.deepEqual(names.slice(0, 9), ['חנות', 'ספק', 'מספר חשבונית', 'תאריך חשבונית', 'אמצעי תשלום', 'מספר אסמכתא', 'תאריך לתשלום', 'סכום לתשלום', 'סטטוס']);
  assert.ok(!names.includes('שולם'));
});

test('"תאריך חשבונית" is the invoice date and "תאריך לתשלום" is the check date — never mixed up', async () => {
  const sec = await secretary(db);
  const sup = (await approveSupplier((await createSupplier({ name: 'ספק עמודות' }, sec, db)).id, ow, db)).id;
  const inv = (await createInvoice(
    { supplierId: sup, storeId: store.id, invoiceNumber: 'COL-1', invoiceDate: '2026-08-10',
      amountBeforeVat: toAgorot('100'), vatAmount: 0, docType: 'tax_invoice', confirm: true },
    sec, db,
  )).invoice;
  const acct = await accountForStore(db, store.id);
  await createPayment({ bankAccountId: acct.id, checkNumber: '7788', paymentDate: '2026-08-25', invoiceIds: [inv.id] }, ow, db);
  await createInvoice(
    { supplierId: sup, storeId: store.id, invoiceNumber: 'COL-2', invoiceDate: '2026-08-11',
      amountBeforeVat: toAgorot('50'), vatAmount: 0, docType: 'tax_invoice', confirm: true },
    sec, db,
  );
  const html = await (await fetch(`${base}/invoices`, { headers: { cookie: `session=${createSession(ow.id)}; ap_store=${store.id}` } })).text();
  const [, storeName, supplier, number, invDate, method, ref, payDate, amount, status] = cellsOf(html, '>COL-1<');
  assert.equal(storeName, store.name);
  assert.match(supplier, /ספק עמודות/);
  assert.equal(number, 'COL-1');
  assert.equal(invDate, '10/08/26', 'the invoice date');
  assert.equal(method, 'צ׳ק');
  assert.equal(ref, '7788');
  assert.equal(payDate, '25/08/26', 'the check date, not the invoice date');
  assert.match(amount, /100\.00/);
  assert.equal(status, 'שולם');
  const unpaid = cellsOf(html, '>COL-2<');
  assert.deepEqual(unpaid.slice(4, 8), ['11/08/26', '—', '—', '—'], 'an unpaid invoice has no method, reference or payment date');
  assert.equal(unpaid[9], 'לא שולם');
});
