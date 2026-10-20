// בעלים, 20/10 — אחרי הדמיה של שלוש אפשרויות: "תבנה את ב׳, בלי סינון בטלפון". בסלולרי (עד 760px) כל
// חשבונית היא כרטיס מקוצר: ספק וסכום למעלה, מספר·תאריך וסטטוס, שורת תשלום רק כשיש. במחשב הטבלה לא משתנה
// — אותן 11 עמודות, אותו סינון, אותו ייצוא — ולכן שורת התשלום של הכרטיס אינה טקסט בתא (הסינון והמיון
// קוראים textContent) אלא ::after מתוך data-payrest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const CELLS = ['c-pick', 'c-store', 'c-sup', 'c-num', 'c-date', 'c-meth', 'c-ref', 'c-paydate', 'c-amt', 'c-status', 'c-note'];

test('every cell of a row carries its card slot, in the column order of the desktop table', () => {
  const v = read('src/views/invoices/index.ejs').replace(/<%#[\s\S]*?%>/g, '');
  const row = v.slice(v.indexOf("<tr onclick=\"location='/invoices/"), v.indexOf('</tr>', v.indexOf("<tr onclick=\"location='/invoices/")));
  const order = [...row.matchAll(/<td class="[^"]*\b(c-[a-z]+)\b/g)].map((m) => m[1]);
  assert.deepEqual(order, CELLS);
  const head = v.slice(v.indexOf('<thead>'), v.indexOf('</thead>'));
  assert.equal((head.match(/<th[ >]/g) || []).length, 11, 'the desktop table keeps its 11 columns');
  assert.match(v, /<table class="sortable inv-cards<%= \(typeof activeStore !== 'undefined' && activeStore\) \? ' one-store' : '' %>"/);
});

test('the card layout lives only under 760px — no headers, no filter row, payment line from data-payrest', () => {
  const css = read('src/public/nocturne.css');
  const at = css.indexOf('דף החשבוניות בסלולרי = כרטיסים');
  assert.ok(at > css.indexOf('main.page, main.page * { text-align: center !important; }'), 'after the centering rule it makes an exception to');
  const block = css.slice(at);
  assert.match(block, /@media \(max-width: 760px\) \{/);
  assert.match(block, /main\.page table\.inv-cards thead \{ display: none; \}/, 'no column titles and no filter row on a phone');
  assert.match(block, /grid-template-areas: "pick sup sup amt" "pick num date status" "note pay pay pay" "store store store store";/);
  assert.match(block, /main\.page table\.inv-cards tr\.is-paid td\.c-meth::after \{ content: attr\(data-payrest\); \}/);
  assert.match(block, /main\.page table\.inv-cards\.one-store td\.c-store \{ display: none; \}/);
});

let db, o, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const page = async (store) => (await fetch(`${base}/invoices`, {
  headers: { cookie: `session=${createSession(o.id)}${store ? `; ap_store=${store}` : ''}` },
})).text();

test('a paid row carries is-paid and its payment line; an unpaid row does not; the cell text stays the method', async () => {
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק כרטיס', 'approved')", []);
  const sup = await db.one("SELECT id FROM suppliers WHERE name = 'ספק כרטיס'", []);
  const ba = await db.one('SELECT id FROM bank_accounts WHERE store_id = 3 LIMIT 1', []);
  for (const n of ['IC-1', 'IC-2']) {
    await createInvoice({ supplierId: sup.id, storeId: 3, invoiceNumber: n, invoiceDate: '2026-10-01', amountBeforeVat: 10000 + n.length * 7 + Number(n.slice(-1)), vatAmount: 1800, docType: 'tax_invoice' }, o, db);
  }
  const paid = await db.one("SELECT id FROM invoices WHERE invoice_number = 'IC-1'", []);
  await approveInvoiceForPayment(paid.id, o, db);
  await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '9001', paymentDate: '2026-10-10', invoiceIds: [paid.id] }, o, db);

  const html = await page(3);
  assert.match(html, /<table class="sortable inv-cards one-store"/, 'a store is active — its name is not repeated on every card');
  const rowOf = (num) => {
    const at = html.indexOf(`<td class="mono c-num">${num}</td>`);
    return html.slice(html.lastIndexOf('<tr ', at), html.indexOf('</tr>', at));
  };
  const p = rowOf('IC-1');
  assert.match(p, /class="[^"]*\bis-paid\b/);
  const meth = p.match(/<td class="c-meth" data-payrest="([^"]*)">([^<]*)<\/td>/);
  assert.ok(meth, 'the method cell carries the rest of the payment line');
  assert.equal(meth[1], ' · ⁨9001⁩ · 10/10/26', 'reference isolated from the Hebrew around it, then the date');
  assert.doesNotMatch(meth[2], /9001|10\/10/, 'the cell text is only the method — the desktop filter and sort read it');
  assert.doesNotMatch(rowOf('IC-2'), /\bis-paid\b/);

  assert.match(await page(null), /<table class="sortable inv-cards"/, '"כל החנויות" — the store shows on each card');
});
