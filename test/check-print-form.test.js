// 🧾 הדפסת צ׳ק על טופס InterCheck (בעלים 29/10: "שבוע הבא אקבל צ׳קים כמו בתמונה — החלק הימני העתק לתיוק,
// השמאלי הצ׳ק לספק. אני רוצה לשלוח תשלום צ׳ק להדפסה שמתאימה לתצורת הצ׳ק"). מודפסים רק הנתונים המשתנים,
// במקומות שנמדדו מה-PDF של הטופס, בשני החצאים. "שלמו ל" = שם הספק; "מס׳ ספק" = ח.פ.; ניכוי במקור — ריק.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { payInvoices, createPayment, voidPayment } from '../src/services/payments.js';
import { LEFT, RIGHT, OUTLINES, MAX_ROWS, detailRows, normalizeOffset } from '../src/lib/checkForm.js';
import { getSetting } from '../src/services/appSettings.js';

let server, base, db, own, sec, st, sup, ba, pay;
const ck = (u) => `session=${createSession(u.id)}; ap_store=${st.id}`;
const get = (path, u = own) => fetch(base + path, { headers: { cookie: ck(u) }, redirect: 'manual' });
const post = (path, body = '', u = own, extra = {}) => fetch(base + path, {
  method: 'POST', redirect: 'manual', body,
  headers: { cookie: ck(u), 'content-type': 'application/x-www-form-urlencoded', ...extra },
});
const field = (html, f) => {
  const m = new RegExp(`data-f="${f}"[^>]*>(?:<span class="num">)?([^<]*)`).exec(html);
  return m ? m[1] : null;
};

before(async () => {
  db = await freshDb();
  own = await owner(db);
  sec = await secretary(db);
  await db.run('INSERT INTO user_companies (user_id, company_id) SELECT ?, company_id FROM stores', [sec.id]).catch(() => {});
  st = await firstStore(db);
  sup = await approveSupplier((await createSupplier({ name: 'מאפיית הבוקר בע"מ' }, own, db)).id, own, db);
  await db.run('UPDATE suppliers SET tax_id = ? WHERE id = ?', ['514737832', sup.id]);
  await db.run('INSERT INTO supplier_stores (supplier_id, store_id) VALUES (?, ?)', [sup.id, st.id]);
  ba = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id]);
  const mk = async (n, net, vat, doc = 'tax_invoice', d = '2026-10-20') => (await createInvoice({
    supplierId: sup.id, storeId: st.id, invoiceNumber: n, invoiceDate: d, amountBeforeVat: net, vatAmount: vat, docType: doc,
    confirm: true, confirmReason: 'בדיקה',
  }, own, db)).invoice;
  const ids = [(await mk('40211', 100000, 18000)).id, (await mk('40238', 50000, 9000, 'tax_invoice', '2026-10-22')).id,
    (await mk('C-77', -20000, -3600, 'credit_note', '2026-10-23')).id];
  ({ payment: pay } = await payInvoices({ bankAccountId: ba.id, method: 'check', checkNumber: '80012345', paymentDate: '2026-11-05', invoiceIds: ids, supplierId: sup.id }, own, db));
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('both halves — original (left) and copy (right) — carry the same data in their own measured boxes', async () => {
  const html = await (await get(`/payments/${pay.id}/print`)).text();
  for (const side of ['orig', 'copy']) {
    assert.equal(field(html, `${side}-to`), 'מאפיית הבוקר בע&#34;מ');
    assert.equal(field(html, `${side}-payee`), 'מאפיית הבוקר בע&#34;מ', 'שלמו ל = שם הספק כמו באפליקציה');
    assert.equal(field(html, `${side}-supno`), '514737832', 'מס׳ ספק = ח.פ.');
    assert.equal(field(html, `${side}-checkno`), '80012345');
    assert.equal(field(html, `${side}-amount`), '**1,534.00**');
    assert.equal(field(html, `${side}-checkdate`), '05/11/2026');
    assert.equal(field(html, `${side}-total`), '1,534.00');
    assert.equal(field(html, `${side}-totalpay`), '1,534.00', 'ניכוי במקור ריק — סה"כ לתשלום = סה"כ');
    assert.match(field(html, `${side}-words`), /^אלף חמש מאות שלושים וארבעה שקלים חדשים בלבד$/);
  }
  const rows = [...html.matchAll(/data-f="orig-row"[^>]*>([^<]*)/g)].map((m) => m[1]);
  assert.deepEqual(rows, ['חשבונית 40211 · 20/10/26', 'חשבונית 40238 · 22/10/26', 'זיכוי C-77 · 23/10/26']);
  const amts = [...html.matchAll(/data-f="orig-rowamt"[^>]*><span class="num">([^<]*)/g)].map((m) => m[1]);
  assert.deepEqual(amts, ['1,180.00', '590.00', '-236.00'], 'a credit prints negative and nets in the total');
  // A4 לרוחב, בלי שוליים — מה שמבטיח שהמיקומים במ"מ יוצאים כפי שנמדדו.
  assert.match(html, /@page \{ size: A4 landscape; margin: 0; \}/);
  assert.match(html, /צ׳ק מס׳ <b class="num">80012345<\/b>/, 'the sheet number in the tray is shown big before printing');
  assert.doesNotMatch(html, /class="outline/, 'a real print has no form lines — they are already on the sheet');
});

test('the measured form: the original is wider than the copy, and every field sits inside the sheet', () => {
  assert.ok(LEFT.payee.x2 - LEFT.payee.x1 > RIGHT.payee.x2 - RIGHT.payee.x1, 'the halves are not mirror images');
  for (const H of [LEFT, RIGHT]) {
    for (const [k, f] of Object.entries(H)) {
      if (k === 'table') continue;
      assert.ok(f.x1 >= 0 && f.x2 <= 297 && f.x1 < f.x2 && f.base > 0 && f.base < 210, `${k} inside the A4 sheet`);
    }
  }
  for (const f of Object.values(LEFT)) if (f.x2 && f.x1 !== undefined) assert.ok(f.x2 <= 158, 'left-half fields stay on the original');
  for (const f of Object.values(RIGHT)) if (f.x1 !== undefined) assert.ok(f.x1 >= 160, 'right-half fields stay on the copy');
  assert.ok(OUTLINES.length >= 20);
});

test('test page: prints the form lines too, for checking against a real sheet in the light', async () => {
  const html = await (await get(`/payments/${pay.id}/print?test=1`)).text();
  assert.equal((html.match(/class="outline/g) || []).length, OUTLINES.length);
  assert.match(html, /דף ניסיון — לא להדפיס על גיליון צ׳ק/);
  assert.doesNotMatch(html, /id="printBtn"/, 'a test page never logs a check print');
});

test('too many documents: the last rows fold into one "ועוד N" row, so the table still sums to the check', () => {
  const lines = Array.from({ length: MAX_ROWS + 3 }, (_, i) => ({ text: `חשבונית ${i}`, amount: 100 }));
  const rows = detailRows(lines);
  assert.equal(rows.length, MAX_ROWS);
  assert.equal(rows.at(-1).text, 'ועוד 4 מסמכים');
  assert.equal(rows.reduce((s, r) => s + r.amount, 0), lines.length * 100);
});

test('printing is logged; a second print warns that it would be a duplicate check', async () => {
  const before = await (await get(`/payments/${pay.id}/print`)).text();
  assert.doesNotMatch(before, /כבר נשלח להדפסה/);
  const r = await post(`/payments/${pay.id}/printed`, '', own, { 'X-Requested-With': 'fetch' });
  assert.equal(r.status, 204);
  const after2 = await (await get(`/payments/${pay.id}/print`)).text();
  assert.match(after2, /כבר נשלח להדפסה <b>1<\/b> פעם/);
  const row = await db.one(`SELECT details FROM audit_log WHERE action = 'payment.check_printed' AND entity_id = ?`, [pay.id]);
  assert.match(row.details, /80012345/);
});

test('calibration offset: owner only, clamped, and it moves every field', async () => {
  assert.deepEqual(normalizeOffset({ dx: '2,5', dy: '-40' }), { dx: 2.5, dy: -15 });
  const deny = await post(`/payments/${pay.id}/print-offset`, 'dx=3&dy=1', sec);
  assert.notEqual(deny.status, 303, 'a secretary cannot move the owner\'s calibration');
  const ok = await post(`/payments/${pay.id}/print-offset`, 'dx=1.5&dy=-2', own);
  assert.equal(ok.status, 303);
  assert.deepEqual(JSON.parse(await getSetting('check_print_offset', '{}', db)), { dx: 1.5, dy: -2 });
  const html = await (await get(`/payments/${pay.id}/print`)).text();
  assert.match(html, /--dx: 1\.5mm; --dy: -2mm;/);
  assert.match(html, /left:calc\(\d+(\.\d+)?mm \+ var\(--dx, 0mm\)\)/);
  const secHtml = await (await get(`/payments/${pay.id}/print`, sec)).text();
  assert.doesNotMatch(secHtml, /print-offset/, 'the calibration form is the owner\'s');
});

test('not a check / voided: nothing to print, back to the payment with the reason', async () => {
  const { invoice } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'T-1', invoiceDate: '2026-10-24',
    amountBeforeVat: 10000, vatAmount: 1800, docType: 'tax_invoice', confirm: true, confirmReason: 'x' }, own, db);
  const tr = await createPayment({ bankAccountId: ba.id, method: 'transfer', reference: 'TR-9', paymentDate: '2026-10-25', invoiceIds: [invoice.id] }, own, db);
  const r1 = await get(`/payments/${tr.id}/print`);
  assert.equal(r1.status, 303);
  assert.match(decodeURIComponent(r1.headers.get('location')), /רק לתשלום מסוג צ׳ק/);
  const { invoice: inv2 } = await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'V-1', invoiceDate: '2026-10-24',
    amountBeforeVat: 20000, vatAmount: 3600, docType: 'tax_invoice', confirm: true, confirmReason: 'x' }, own, db);
  const ck2 = await createPayment({ bankAccountId: ba.id, checkNumber: '80012399', paymentDate: '2026-10-25', invoiceIds: [inv2.id] }, own, db);
  await voidPayment(ck2.id, own, db);
  const r2 = await get(`/payments/${ck2.id}/print`);
  assert.equal(r2.status, 303);
  assert.match(decodeURIComponent(r2.headers.get('location')), /מבוטל/);
  const show = await (await get(`/payments/${ck2.id}`)).text();
  assert.doesNotMatch(show, /הדפס צ׳ק/, 'no print button on a voided check');
});

test('the green notice after issuing a check carries "🖨 הדפס צ׳ק" (owner 29/10); a transfer does not', async () => {
  const html = await (await get(`/invoices/new?paid=${pay.id}`)).text();
  assert.match(html, new RegExp(`<a class="btn small" href="/payments/${pay.id}/print" target="_blank">🖨 הדפס צ׳ק</a>`));
  const tr = await db.one(`SELECT id FROM payments WHERE method = 'transfer' LIMIT 1`, []);
  const html2 = await (await get(`/invoices/new?paid=${tr.id}`)).text();
  assert.doesNotMatch(html2, /🖨 הדפס צ׳ק/);
});

test('a single invoice paid by check from its own form lands on the invoice with the same print button', async () => {
  const fd = new FormData();
  const fields = { ctx_store: st.id, store_id: st.id, supplier_id: sup.id, invoice_number: 'S-55', invoice_date: '2026-10-26',
    doc_type: 'tax_invoice', amount_before_vat: '300', vat_amount: '54', pay_method: 'check', check_number: '80012400', check_due_date: '2026-11-10' };
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const r = await fetch(`${base}/invoices`, { method: 'POST', redirect: 'manual', headers: { cookie: ck(own) }, body: fd });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  const m = /^\/invoices\/(\d+)\?paid=(\d+)$/.exec(loc);
  assert.ok(m, `redirect carries the payment id: ${loc}`);
  const html = await (await get(loc)).text();
  assert.match(html, /החשבונית נוצרה והתשלום נוצר ושויך אליה\./);
  assert.match(html, new RegExp(`href="/payments/${m[2]}/print" target="_blank"[^>]*>🖨 הדפס צ׳ק`));
});
