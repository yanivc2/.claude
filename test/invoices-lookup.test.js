// דף החשבוניות (בעלים, 18/10): שדה החיפוש הוחלף באריח של לוח הבקרה (partials/_lookupForm.ejs) — שם ספק /
// מספר, מתאריך / עד תאריך, "חיפוש" (לא "סנן"), "לא שולמו בלבד" ומתחתיו "נקה"; ו"+ חשבונית חדשה" עבר לשורת
// הכותרת, משמאל ל"→ חזרה".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
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

test('the search is the dashboard tile: name/number, from/to, "חיפוש", "לא שולמו בלבד" then "נקה"', async () => {
  const html = await page('?status=recorded');
  const form = html.slice(html.indexOf('class="lookup-form"'), html.indexOf('</form>', html.indexOf('class="lookup-form"')));
  assert.ok(form.length > 100, 'the tile form is on the page');
  assert.match(form, /<input type="hidden" name="status" value="recorded"/, 'the status filter is kept');
  const at = (s) => form.indexOf(s);
  assert.ok(at('name="name"') < at('name="q"') && at('name="q"') < at('name="from"') && at('name="from"') < at('name="to"'));
  assert.match(form, /data-suggest="sup-names"/, 'supplier-name suggestions');
  assert.match(form, /<button type="submit">חיפוש<\/button>/, '"חיפוש", not "סנן"');
  assert.doesNotMatch(html, />סנן</);
  assert.ok(at('לא שולמו בלבד') > at('>חיפוש<') && at('>נקה<') > at('לא שולמו בלבד'), '"נקה" under "לא שולמו בלבד"');
  assert.match(form, /<a href="\/invoices\?status=recorded" class="btn btn-secondary btn-sm lookup-clear">נקה<\/a>/, 'clears the search, keeps the status');
  assert.doesNotMatch(html, /filt-toggle/, 'the old checkbox panel is gone');
});

test('"+ חשבונית חדשה" sits in the header row (right side, after "→ חזרה"), not in the page toolbar', async () => {
  const html = await page();
  const start = html.indexOf('class="sb-side sb-start"');
  const menu = html.indexOf('top-new-invoice');
  const center = html.indexOf('class="sb-center"');
  assert.ok(start > 0 && menu > start && menu < center, 'inside .sb-start (the footer puts "→ חזרה" first)');
  assert.equal((html.match(/top-new-invoice/g) || []).length, 1, 'once — not also in the toolbar');
});

test('the filters: supplier name, invoice-date range (flipped when reversed), unpaid only, with the status menu', async () => {
  assert.deepEqual(found(await page('?name=' + encodeURIComponent('טרה'))), ['6001', '6002']);
  assert.deepEqual(found(await page('?from=2026-10-01')), ['6002', '6003']);
  assert.deepEqual(found(await page('?from=2026-10-31&to=2026-10-01')), ['6002', '6003'], 'reversed range');
  assert.deepEqual(found(await page('?name=' + encodeURIComponent('טרה') + '&from=2026-10-01')), ['6002']);
  assert.deepEqual(found(await page('?q=6003')), ['6003']);
  assert.deepEqual(found(await page('?unpaid=1')), ['6001', '6002', '6003']);
  assert.deepEqual(found(await page('?status=paid&unpaid=1')), [], 'unpaid-only adds to the status filter');
});
