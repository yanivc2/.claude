// בעלים (2026-10-11): "זה לא סיכם לי את 2 החשבוניות". הזנה של שתי חשבוניות לאותו ספק ותשלום אחד
// בהעברה — אמצעי התשלום של החשבונית החדשה משלם גם את מה שמסומן ב"שיוך לתשלום" מתחתיה,
// ו"שמור והוסף עוד לספק" לא משלם באמצע אלא מעביר את אמצעי התשלום הלאה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { getPaymentDetail } from '../src/services/payments.js';

let server, base, db, own, sup, other, st, first;
const ck = () => `session=${createSession(own.id)}; ap_store=${st.id}`;
let n = 0;
const postInvoice = (fields) => {
  n += 1;
  const fd = new FormData();
  const base0 = {
    ctx_store: String(st.id), store_id: String(st.id), supplier_id: String(sup.id),
    invoice_number: `PW-${n}`, invoice_date: `2026-09-${String(10 + n).padStart(2, '0')}`,
    amount_before_vat: String(1000 + n), vat_amount: '0', doc_type: 'tax_invoice',
  };
  for (const [k, v] of Object.entries({ ...base0, ...fields })) {
    for (const one of [].concat(v)) fd.append(k, String(one));
  }
  return fetch(`${base}/invoices`, { method: 'POST', redirect: 'manual', headers: { cookie: ck() }, body: fd });
};

before(async () => {
  db = await freshDb();
  own = await owner(db);
  st = await firstStore(db);
  sup = await approveSupplier((await createSupplier({ name: 'שטראוס בדיקה' }, own, db)).id, own, db);
  other = await approveSupplier((await createSupplier({ name: 'ספק זר' }, own, db)).id, own, db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('"שמור והוסף עוד לספק" with a method chosen pays nothing yet and carries the method on', async () => {
  const r = await postInvoice({ action: 'add_another', pay_method: 'transfer', transfer_ref: '777123', transfer_date: '2026-09-30' });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  const q = new URLSearchParams(loc.split('?')[1]);
  assert.equal(q.get('added'), '1');
  assert.equal(q.get('pay'), 'transfer');
  assert.equal(q.get('transfer_ref'), '777123');
  first = await db.one("SELECT * FROM invoices WHERE invoice_number = 'PW-1'", []);
  const lines = await db.many('SELECT * FROM payment_lines WHERE invoice_id = ?', [first.id]);
  assert.equal(lines.length, 0, 'no payment for the first invoice on its own');

  const html = await (await fetch(`${base}${loc}`, { headers: { cookie: ck() } })).text();
  assert.match(html, /<option value="transfer" selected>העברה<\/option>/);
  assert.match(html, /name="transfer_ref" value="777123"/, 'what was typed survives');
  assert.match(html, /id="pay_with_ids"/, 'the new invoice\'s payment can take the earlier one along');
  assert.match(html, new RegExp(`class="bp-check"[^>]*value="${first.id}"[^>]*data-open="${first.total_amount}"[^>]*checked`));
});

test('the last save pays the new invoice AND the ticked earlier one — one payment, summed', async () => {
  const r = await postInvoice({ pay_method: 'transfer', transfer_ref: '777123', transfer_date: '2026-09-30', with_invoice_ids: [first.id] });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/invoices\/new\?paid=\d+$/, 'back to a fresh form for the next payment (owner 25/10)');
  const pay = await getPaymentDetail(Number(new URLSearchParams(loc.split('?')[1]).get('paid')), db);
  const second = await db.one("SELECT * FROM invoices WHERE invoice_number = 'PW-2'", []);
  assert.equal(pay.method, 'transfer');
  assert.equal(pay.reference, '777123');
  assert.equal(pay.amount, first.total_amount + second.total_amount, 'the sum of both invoices');
  assert.deepEqual(pay.lines.map((l) => Number(l.invoice_id)).sort((a, b) => a - b), [first.id, second.id].sort((a, b) => a - b));
});

test('an id the section could not have offered (another supplier) is ignored, not paid', async () => {
  await createInvoice({ supplierId: other.id, storeId: st.id, invoiceNumber: 'ZR-1', invoiceDate: '2026-09-01', amountBeforeVat: 5000, vatAmount: 0, docType: 'tax_invoice' }, own, db);
  const foreign = await db.one("SELECT * FROM invoices WHERE invoice_number = 'ZR-1'", []);
  const r = await postInvoice({ pay_method: 'transfer', transfer_ref: '888', with_invoice_ids: [foreign.id] });
  assert.equal(r.status, 303);
  const lines = await db.many('SELECT * FROM payment_lines WHERE invoice_id = ?', [foreign.id]);
  assert.equal(lines.length, 0, 'the foreign invoice stays unpaid');
  const mine = await db.one("SELECT * FROM invoices WHERE invoice_number = 'PW-3'", []);
  const myLines = await db.many('SELECT * FROM payment_lines WHERE invoice_id = ?', [mine.id]);
  assert.equal(myLines.length, 1, 'the new invoice is paid on its own');
});

test('a ?pay= value outside the methods list is ignored', async () => {
  const html = await (await fetch(`${base}/invoices/new?pay=bogus`, { headers: { cookie: ck() } })).text();
  assert.ok(!/<option value="[a-z_]+" selected>(צ׳ק|העברה|מזומן|אשראי|הו"ק)<\/option>/.test(html));
});
