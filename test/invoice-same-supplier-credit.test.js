// בעלים 25/10: "כשאני בוחר להוסיף עוד חשבונית לספק [מדף החשבונית ← '➕ לאותו ספק'], ממלאה פרטי זיכוי — למה
// זה לא מחשב את סכום החשבונית ומחסיר את סכום הזיכוי?" הקישור פתח טופס שבו החשבונית שממנה באו לא הייתה
// מסומנת ב"שיוך לתשלום", ולכן סכום הצ׳ק היה רק מינוס הזיכוי. עכשיו הקישור נושא with=<החשבונית>.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { getPaymentDetail } from '../src/services/payments.js';

let server, base, db, own, sup, other, st, inv, foreign;
const ck = () => `session=${createSession(own.id)}; ap_store=${st.id}`;
const get = async (path) => (await fetch(base + path, { headers: { cookie: ck() } })).text();

before(async () => {
  db = await freshDb();
  own = await owner(db);
  st = await firstStore(db);
  sup = await approveSupplier((await createSupplier({ name: 'טרה בדיקה' }, own, db)).id, own, db);
  other = await approveSupplier((await createSupplier({ name: 'ספק אחר' }, own, db)).id, own, db);
  ({ invoice: inv } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'SS-1', invoiceDate: '2026-10-20', amountBeforeVat: 100000, vatAmount: 18000, docType: 'tax_invoice' }, own, db));
  ({ invoice: foreign } = await createInvoice({ supplierId: other.id, storeId: st.id, invoiceNumber: 'SS-X', invoiceDate: '2026-10-20', amountBeforeVat: 5000, vatAmount: 0, docType: 'tax_invoice' }, own, db));
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('"➕ לאותו ספק" on an invoice page carries that invoice along', async () => {
  const html = await get(`/invoices/${inv.id}`);
  const href = `/invoices/new?supplier=${sup.id}&amp;store=${st.id}&amp;with=${inv.id}`;
  assert.ok(html.includes(`<a href="${href}" class="btn btn-secondary">➕ לאותו ספק</a>`));
  assert.ok(html.includes(`<a href="${href}">➕ חשבונית / זיכוי נוסף לאותו ספק</a>`));
});

test('the new form opens with that invoice ticked in "שיוך לתשלום" — so a credit typed there nets against it', async () => {
  const html = await get(`/invoices/new?supplier=${sup.id}&store=${st.id}&with=${inv.id}`);
  assert.match(html, new RegExp(`class="bp-check"[^>]*value="${inv.id}"[^>]*data-open="${inv.total_amount}"[^>]*checked`));
  // מזהה שאינו של הספק הזה — לא מסומן ולא מופיע.
  const odd = await get(`/invoices/new?supplier=${sup.id}&store=${st.id}&with=${foreign.id}`);
  assert.doesNotMatch(odd, new RegExp(`value="${foreign.id}"[^>]*checked`));
  assert.match(odd, new RegExp(`class="bp-check"[^>]*value="${inv.id}"(?![^>]*checked)[^>]*>`), 'nothing ticked by default without with=');
});

test('saving the credit with the invoice ticked creates ONE check for the net (invoice − credit)', async () => {
  const fd = new FormData();
  const fields = {
    ctx_store: st.id, store_id: st.id, supplier_id: sup.id, invoice_number: 'SS-C1', invoice_date: '2026-10-21',
    doc_type: 'credit_note', amount_before_vat: '100', vat_amount: '18',
    pay_method: 'check', check_number: '50123', check_due_date: '2026-11-01', with_invoice_ids: inv.id,
  };
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const r = await fetch(`${base}/invoices`, { method: 'POST', redirect: 'manual', headers: { cookie: ck() }, body: fd });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/invoices\?paid=\d+/);
  const pay = await getPaymentDetail(Number(new URLSearchParams(loc.split('?')[1]).get('paid')), db);
  assert.equal(pay.method, 'check');
  assert.equal(pay.amount, 118000 - 11800, '₪1,180 − ₪118 = ₪1,062');
});

test('a credit with nothing to net against says so instead of showing a silent negative', () => {
  const view = readFileSync(new URL('../src/views/invoices/new.ejs', import.meta.url), 'utf8');
  assert.match(view, /var short = sel\.value && t < 0;/);
  assert.match(view, /זיכוי לבד אינו תשלום — סמן ב"שיוך לתשלום" למטה את החשבונית שהזיכוי מקזז/);
});
