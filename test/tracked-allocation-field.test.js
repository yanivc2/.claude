// בעלים 22/10, מעוקבות לתשלום: "תתאים את הרקע כמו כולם" · "לא צריך כל כך הרבה מלל — מספיק ללא מספר הקצאה; מתחת
// לזה רובריקה 'הוסף מספר הקצאה' (הכתוב בתוכה) וכפתור שמור משמאלו".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createInvoice } from '../src/services/invoices.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';

let db, o, st, held, server, base;
const cookie = () => `session=${createSession(o.id)}; ap_store=${st.id}`;
before(async () => {
  db = await freshDb(); o = await owner(db); st = await firstStore(db);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק R3' }, o, db)).id, o, db);
  await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'R3-1', invoiceDate: '2026-09-01', amountBeforeVat: 10000000, vatAmount: 1800000, docType: 'tax_invoice', allocationNumber: null }, o, db);
  held = await db.one("SELECT * FROM invoices WHERE invoice_number = 'R3-1'", []);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('a held R3 row says only "ללא מספר הקצאה", with an "הוסף מספר הקצאה" field and "שמור" to its left; no orange rows', async () => {
  assert.equal(held.status, 'on_hold');
  const html = await (await fetch(`${base}/tracked-invoices`, { headers: { cookie: cookie() } })).text();
  const row = html.slice(html.indexOf('R3-1'), html.indexOf('</tr>', html.indexOf('R3-1')));
  assert.match(row, /<form method="post" action="\/tracked-invoices\/\d+\/allocation" class="tracked-note tracked-alloc" data-busy="שומר…">\s*<span class="alloc-field">\s*<span class="tracked-r3">ללא מספר הקצאה<\/span>\s*<input name="allocation_number"[^>]*placeholder="הוסף מספר הקצאה"[^>]*\/>\s*<\/span>\s*<button type="submit" class="btn-sm">שמור<\/button>/, 'the caption sits with the field, centred over it; שמור beside them');
  assert.doesNotMatch(row, /מוחזקת:|R3 —|למשל: מחכים לזיכוי/, 'no long hold text, no note field on a held-only R3 row');
  assert.doesNotMatch(html, /class="row-tracked"/);
});

test('saving the allocation number releases the hold and the row leaves the page; a bad number comes back as an error', async () => {
  const post = (v) => fetch(`${base}/tracked-invoices/${held.id}/allocation`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: cookie(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ allocation_number: v }).toString(),
  });
  let r = await post('12');
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /err=מספר הקצאה חייב להיות לפחות 6 ספרות/);
  r = await post('123456789');
  assert.equal(r.headers.get('location'), '/tracked-invoices?saved=allocation');
  const inv = await db.one('SELECT status, allocation_number FROM invoices WHERE id = ?', [held.id]);
  assert.deepEqual([inv.status, inv.allocation_number], ['recorded', '123456789']);
  const html = await (await fetch(base + r.headers.get('location'), { headers: { cookie: cookie() } })).text();
  assert.match(html, /מספר ההקצאה נשמר והחשבונית שוחררה מההחזקה\./);
  assert.doesNotMatch(html, />R3-1</);
});
