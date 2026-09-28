// 📝 הערות לחשבונית — עמודה בדף החשבוניות (כפתור שפותח חלון), ומהנפקת תשלום (נכתבת על החשבוניות
// ששולמו ומופיעה בדף החשבוניות).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, setInvoiceNote, appendInvoiceNote, INVOICE_NOTE_MAX } from '../src/services/invoices.js';

let server, base, db, sup, st, own;
const cookie = () => `session=${createSession(own.id)}`;
const form = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(),
});
let n = 0;
const newInvoice = async () => (await createInvoice({
  supplierId: sup.id, storeId: st.id, invoiceNumber: `NT${++n}`, invoiceDate: '2026-09-01', amountBeforeVat: 10000 + n * 137, vatAmount: 1800, docType: 'tax_invoice',
}, own, db)).invoice;
const noteOf = async (id) => (await db.one('SELECT notes FROM invoices WHERE id = ?', [id])).notes;

before(async () => {
  db = await freshDb();
  own = await owner(db);
  st = await firstStore(db);
  sup = await approveSupplier((await createSupplier({ name: 'ספק הערות' }, own, db)).id, own, db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('שירות: קביעה, מחיקה, אורך מקסימלי, והוספה שלא מוחקת הערה קיימת', async () => {
  const inv = await newInvoice();
  assert.equal(await setInvoiceNote(inv.id, '  ספק ביקש להעביר לחשבון אחר  ', own, db), 'ספק ביקש להעביר לחשבון אחר');
  await appendInvoiceNote([inv.id], 'שולם בצ׳ק 4242', own, db);
  assert.equal(await noteOf(inv.id), 'ספק ביקש להעביר לחשבון אחר\nשולם בצ׳ק 4242');
  assert.equal(await setInvoiceNote(inv.id, '', own, db), null);
  assert.equal(await noteOf(inv.id), null);
  await assert.rejects(() => setInvoiceNote(inv.id, 'x'.repeat(INVOICE_NOTE_MAX + 1), own, db), /ארוכה מדי/);
  assert.equal(await appendInvoiceNote([inv.id], '   ', own, db), 0, 'הערה ריקה בתשלום לא נוגעת בחשבונית');
});

test('דף החשבוניות: עמודת "הערות" משמאל ל"שולם", 📝 כשיש הערה, והטקסט מוחרג (לא HTML)', async () => {
  const inv = await newInvoice();
  await setInvoiceNote(inv.id, '<img src=x onerror=alert(1)> "ציטוט"', own, db);
  const html = await (await fetch(`${base}/invoices`, { headers: { cookie: cookie() } })).text();
  assert.match(html, /<th>שולם<\/th><th data-nosort>הערות<\/th>/, 'הערות היא העמודה שאחרי שולם (משמאל לה ב-RTL)');
  assert.match(html, /id="noteDlg"/);
  const btn = html.match(new RegExp(`<button type="button" class="note-btn has-note"[^>]*data-id="${inv.id}"[^>]*>`))?.[0];
  assert.ok(btn, 'יש כפתור 📝 לחשבונית עם הערה');
  assert.ok(!btn.includes('<img'), 'הטקסט מוחרג במאפיין');
  assert.match(btn, /data-note="&lt;img src=x onerror=alert\(1\)&gt; &#34;ציטוט&#34;"/);
});

test('שמירת הערה מהחלון → 303 חזרה לאותה רשימה; כתובת חזרה חיצונית נדחית', async () => {
  const inv = await newInvoice();
  let r = await form(`/invoices/${inv.id}/note`, { note: 'לבדוק מול הספק', back: '/invoices?status=unpaid' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/invoices?status=unpaid');
  assert.equal(await noteOf(inv.id), 'לבדוק מול הספק');
  r = await form(`/invoices/${inv.id}/note`, { note: 'x', back: 'https://evil.example/' });
  assert.equal(r.headers.get('location'), '/invoices');
  r = await form(`/invoices/${inv.id}/note`, { note: 'x', back: '//evil.example/invoices' });
  assert.equal(r.headers.get('location'), '/invoices');
});

test('הערה בעת "הנפק תשלום לנבחרים" נכתבת על כל החשבוניות ששולמו', async () => {
  const a = await newInvoice();
  const b = await newInvoice();
  await setInvoiceNote(a.id, 'הערה קודמת', own, db);
  const body = new URLSearchParams({ supplier_id: String(sup.id), store_id: String(st.id), pay_method: 'check', check_number: '9001', check_due_date: '2026-09-10', pay_note: 'צ׳ק נמסר לנהג' });
  body.append('invoice_ids', String(a.id));
  body.append('invoice_ids', String(b.id));
  const r = await fetch(`${base}/invoices/pay-batch`, { method: 'POST', redirect: 'manual', headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' }, body });
  assert.equal(r.status, 303);
  assert.equal(await noteOf(a.id), 'הערה קודמת\nצ׳ק נמסר לנהג', 'נוספת, לא מחליפה');
  assert.equal(await noteOf(b.id), 'צ׳ק נמסר לנהג');
});

test('הערה בטופס "תשלום חדש" נכתבת על החשבוניות המסומנות', async () => {
  const a = await newInvoice();
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id])).id;
  const r = await form('/payments', { bank_account_id: String(acct), method: 'check', check_number: '9002', payment_date: '2026-09-11', invoice_ids: String(a.id), note: 'תשלום חלקי סוכם בטלפון' });
  assert.equal(r.status, 303);
  assert.equal(await noteOf(a.id), 'תשלום חלקי סוכם בטלפון');
});

test('הערה בקטע "אמצעי תשלום" בהזנת חשבונית נשמרת על החשבונית שנוצרה', async () => {
  const r = await form('/invoices', {
    supplier_id: String(sup.id), store_id: String(st.id), invoice_number: 'NT-NEW', invoice_date: '2026-09-02',
    amount_before_vat: '77.70', vat_amount: '13.99', doc_type: 'tax_invoice', pay_method: 'check', check_number: '9003',
    check_due_date: '2026-09-12', pay_note: 'נשלם בסוף החודש',
  });
  assert.equal(r.status, 303);
  const inv = await db.one('SELECT id, notes FROM invoices WHERE invoice_number = ?', ['NT-NEW']);
  assert.equal(inv.notes, 'נשלם בסוף החודש');
});

test('שדות ההערה מופיעים בטופסי התשלום', async () => {
  const pay = await (await fetch(`${base}/payments/new`, { headers: { cookie: cookie() } })).text();
  assert.match(pay, /name="note"/);
  const inv = await (await fetch(`${base}/invoices/new?supplier=${sup.id}&store=${st.id}`, { headers: { cookie: cookie() } })).text();
  assert.ok((inv.match(/name="pay_note"/g) || []).length >= 1);
});
