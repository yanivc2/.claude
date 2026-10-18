// דף החשבוניות (בעלים, 18/10): "+ חשבונית חדשה" בשורת הכותרת, משמאל ל"→ חזרה"; אריח החיפוש שהוצב כאן
// לזמן קצר הוסר ("בטל את זה") — החיפוש בדף הוא זה שעל הטבלה, והכתובת עדיין מסננת; תיבת הבחירה לתשלום
// מרוכז גדולה וכל התא לוחץ; "ייצוא" מתחת לטבלה (בכל הטבלאות).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createInvoice } from '../src/services/invoices.js';

let db, o, st, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  for (const n of ['טרה', 'תנובה']) await db.run("INSERT INTO suppliers (name, status) VALUES (?, 'approved')", [n]);
  const tera = await db.one("SELECT id FROM suppliers WHERE name = 'טרה'", []);
  const tnuva = await db.one("SELECT id FROM suppliers WHERE name = 'תנובה'", []);
  for (const [sup, n, d, a] of [[tera, '6001', '2026-09-20', 10000], [tera, '6002', '2026-10-05', 12000], [tnuva, '6003', '2026-10-16', 15000]]) {
    await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: n, invoiceDate: d, amountBeforeVat: a, vatAmount: 0, docType: 'tax_invoice' }, o, db);
  }
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const page = async (qs = '') => (await fetch(`${base}/invoices${qs}`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
const found = (html) => ['6001', '6002', '6003'].filter((n) => html.includes(`>${n}<`));

test('above the list: no search tile, no "סינון · …", no hint line, no "חיפוש בטבלה…" — only the column filters (owner, 18/10)', async () => {
  const html = await page();
  assert.doesNotMatch(html, /class="lookup-form"/);
  assert.doesNotMatch(html, />סנן</);
  assert.doesNotMatch(html, /filt-toggle/, 'the old checkbox panel is gone too');
  assert.doesNotMatch(html, /סינון · /, 'no status menu');
  assert.doesNotMatch(html, /לחיצה על שורה פותחת את פרטי החשבונית/, 'no hint line');
  assert.match(html, /<table class="sortable no-search" data-export-into="payExport">/, 'no free-text search row; export goes to the bottom bar');
  assert.match(html, /<h1>חשבוניות<\/h1>/);
  assert.match(await page('?status=on_hold'), /<h1>חשבוניות · מוחזקות<\/h1>/, 'a ?status= link still filters, and the title says so');
});

test('"ייצוא" of the invoices table sits in the bottom bar, before "בטל בחירה" (owner, 18/10)', async () => {
  const html = await page();
  const bar = html.slice(html.indexOf('id="payBar"'), html.indexOf('</div>', html.indexOf('id="payClear"')));
  assert.ok(bar.indexOf('<span id="payExport"></span>') > 0 && bar.indexOf('<span id="payExport"></span>') < bar.indexOf('id="payClear"'), 'the slot comes first in the button group');
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /\.tbl-foot \.tbl-export-menu, \.pay-bar \.tbl-export-menu \{ top: auto; bottom: calc\(100% \+ 4px\);/, 'opens upward there too');
});

test('picking an invoice for a combined payment: a big box, and the whole cell toggles it (one tap)', async () => {
  const html = await page();
  assert.match(html, /<td class="no-print inv-pick-cell" onclick="event\.stopPropagation\(\); if \(event\.target\.classList\.contains\('inv-pick'\)\) return; var c = this\.querySelector\('\.inv-pick'\); if \(c && !c\.disabled\) \{ c\.checked = !c\.checked; c\.dispatchEvent\(new Event\('change', \{ bubbles: true \}\)\); \}">/);
  assert.match(html, /<input type="checkbox" class="inv-pick" aria-label="סמן לתשלום מרוכז"/);
  assert.doesNotMatch(html, /class="inv-pick" style="width:auto;min-height:0"/, 'no longer the tiny native box');
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /\.inv-pick-cell input\.inv-pick \{ width: 24px; height: 24px;/);
  assert.match(css, /\.inv-pick-cell \{ cursor: pointer; min-width: 52px; touch-action: manipulation;/);
});

test('"ייצוא" sits under every table, in its own centred row; the menu opens upward (owner, 18/10)', () => {
  const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /var foot = document\.createElement\('div'\); foot\.className = 'tbl-foot no-print';\n\s*foot\.appendChild\(exportWrap\);/);
  assert.match(footer, /if \(!table\.classList\.contains\('no-search'\)\) anchor\.parentNode\.insertBefore\(tools, anchor\);/, 'search above (unless no-search)');
  assert.match(footer, /if \(exportSlot\) exportSlot\.appendChild\(exportWrap\);\n\s*else anchor\.parentNode\.insertBefore\(foot, anchor\.nextSibling\);/, 'export below, or into the element the table names');
  assert.doesNotMatch(footer, /tools\.appendChild\(exportWrap\)/, 'not in the search row any more');
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /\.tbl-foot \{ display: flex; justify-content: center;/);
  assert.match(css, /\.tbl-foot \.tbl-export-menu, \.pay-bar \.tbl-export-menu \{ top: auto; bottom: calc\(100% \+ 4px\);/);
});

test('"+ חשבונית חדשה" sits in the header row (right side, after "→ חזרה"), not in the page toolbar', async () => {
  const html = await page();
  const start = html.indexOf('class="sb-side sb-start"');
  const menu = html.indexOf('top-new-invoice');
  const center = html.indexOf('class="sb-center"');
  assert.ok(start > 0 && menu > start && menu < center, 'inside .sb-start (the footer puts "→ חזרה" first)');
  assert.equal((html.match(/top-new-invoice/g) || []).length, 1, 'once — not also in the toolbar');
});

test('the URL still filters: supplier name, invoice-date range (flipped when reversed), unpaid only, with the status menu', async () => {
  assert.deepEqual(found(await page('?name=' + encodeURIComponent('טרה'))), ['6001', '6002']);
  assert.deepEqual(found(await page('?from=2026-10-01')), ['6002', '6003']);
  assert.deepEqual(found(await page('?from=2026-10-31&to=2026-10-01')), ['6002', '6003'], 'reversed range');
  assert.deepEqual(found(await page('?name=' + encodeURIComponent('טרה') + '&from=2026-10-01')), ['6002']);
  assert.deepEqual(found(await page('?q=6003')), ['6003']);
  assert.deepEqual(found(await page('?unpaid=1')), ['6001', '6002', '6003']);
  assert.deepEqual(found(await page('?status=paid&unpaid=1')), [], 'unpaid-only adds to the status filter');
});

test('"✓" at the head of the pick column filters to the invoices that can be picked; again = all (owner, 18/10)', async () => {
  const html = await page();
  assert.match(html, /<th class="no-print pick-head" data-nosort role="button" tabindex="0" aria-pressed="false"/);
  const rows = html.match(/<tr onclick="location='\/invoices\/\d+'"[^>]*>/g) || [];
  assert.ok(rows.length >= 3 && rows.every((r) => !/not-pickable/.test(r)), 'unpaid invoices stay visible under the filter');
  const view = readFileSync(new URL('../src/views/invoices/index.ejs', import.meta.url), 'utf8');
  assert.match(view, /class="<%= rowCls %><%= selectable \? '' : ' not-pickable' %>"/, 'the server marks what cannot be picked');
  assert.match(view, /table\.classList\.toggle\('only-pickable', on\);/);
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /table\.only-pickable tbody tr\.not-pickable \{ display: none; \}/);
  assert.match(css, /th\.pick-head\[aria-pressed="true"\] \{ background: var\(--color-accent\); color: #fff; \}/);
});

test('every table: the column-title row is bold, dark and tinted; the filter row under it stays quiet (owner, 18/10)', () => {
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /thead tr:not\(\.filter-row\) th \{\n  color: var\(--color-text\); font-weight: 700; font-size: 13px;/);
  assert.match(css, /border-bottom: 2px solid color-mix\(in srgb, var\(--color-accent\) 45%, var\(--color-line\)\);/);
});

test('מרקורים → הצהרות הפקדה: no explanation line and no "חיפוש בטבלה…" (owner, 18/10)', () => {
  const pay = readFileSync(new URL('../src/views/payments/index.ejs', import.meta.url), 'utf8').replace(/<%#[\s\S]*?%>/g, '');
  assert.doesNotMatch(pay, /הפקדות שהוצהרו בדוחות Z/);
  assert.match(pay, /rows: deposits, verify: depVerify, zdiff: depZDiff, actions: true, noSearch: true,/);
  const dep = readFileSync(new URL('../src/views/partials/_deposits.ejs', import.meta.url), 'utf8');
  assert.match(dep, /\(typeof noSearch !== 'undefined' && noSearch\) \? ' no-search' : ''/);
});
