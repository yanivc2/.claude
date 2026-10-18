// לוח הבקרה לפי בקשת הבעלים (16/10): בלי "פעולות מהירות" ("אפשרויות" עבר לשורת הכותרת, בצד ימין — 18/10),
// "צ׳קים בחוץ" במקום "צ׳קים פתוחים" ובלי בורר חנות משלו, בדיקת חשבונית באריח — חנות פעילה בלבד, שם
// ומספר בשדות נפרדים (מקלדת מספרים), "לא שולמו בלבד"; "העברה בבנק ללא תיעוד" בתחתית ומכווץ.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createInvoice } from '../src/services/invoices.js';
import { createZReport } from '../src/services/zreports.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { lastBankPullFor } from '../src/services/reports.js';

let db, o, st, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  const sup = await db.one("SELECT id FROM suppliers WHERE name = 'טרה'", []);
  await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: '55012', invoiceDate: '2026-10-14', amountBeforeVat: 31000, vatAmount: 0, docType: 'tax_invoice' }, o, db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const page = async (qs = '') => (await fetch(`${base}/${qs}`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();

test('dashboard: no quick-actions card; "אפשרויות" sits on the RIGHT side of the header bar (owner, 17/10)', async () => {
  const html = await page();
  assert.doesNotMatch(html, /פעולות מהירות/);
  const start = html.indexOf('class="sb-side sb-start"');
  const menu = html.indexOf('store-banner-quick');
  const center = html.indexOf('class="sb-center"');
  assert.ok(start > 0 && menu > start && menu < center, 'in the right-hand side of the bar, before the centred picker');
  assert.ok(menu < html.indexOf('<h1'), 'in the bar, above the page title');
});

test('dashboard: "checks outside" first, no store picker in it; the lookup tile has no store/company picker', async () => {
  const html = await page();
  assert.doesNotMatch(html, /צ׳קים פתוחים</);
  assert.doesNotMatch(html, /oc_store=/, 'no per-tile store picker');
  assert.doesNotMatch(html, /name="store"|name="company"/, 'the lookup is the active store only');
  const out = html.indexOf('צ׳קים בחוץ ·');
  assert.ok(out > 0 && out < html.indexOf('ספקים ממתינים לאישור'), 'the first tile');
  assert.match(html, /<input name="q"[^>]*inputmode="numeric"/, 'number field → numeric keyboard');
  assert.match(html, /<input name="name"/);
  assert.match(html, /לא שולמו בלבד/);
  assert.doesNotMatch(html, /רק שלא שולמו/);
});

test('dashboard lookup: three columns — search fields stacked on the right, from/to dates stacked in the middle, a big "חפש" over "לא שולמו בלבד" on the left (owner, 18/10)', async () => {
  const html = await page();
  const form = html.slice(html.indexOf('class="lookup-form"'), html.indexOf('</form>', html.indexOf('class="lookup-form"')));
  const at = (needle) => form.indexOf(needle);
  assert.ok(at('class="lookup-col lookup-terms"') > 0, 'right column');
  assert.ok(at('name="name"') > at('lookup-terms') && at('name="q"') > at('name="name"'), 'name over number');
  assert.ok(at('class="lookup-col lookup-dates"') > at('name="q"'), 'then the dates column');
  assert.ok(at('<input type="date" name="from"') > at('lookup-dates') && at('<input type="date" name="to"') > at('name="from"'), 'from over to');
  assert.match(form, /placeholder="מתאריך"/);
  assert.match(form, /placeholder="עד תאריך"/);
  assert.ok(at('class="lookup-go"') > at('name="to"') && at('>חפש</button>') > at('lookup-go') && at('לא שולמו בלבד') > at('>חפש</button>'), 'then [חפש] over [לא שולמו בלבד]');
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /\.lookup-form \{ display: flex; flex-wrap: nowrap;/, 'one row of columns');
  assert.match(css, /\.lookup-col \{ display: flex; flex-direction: column;/, 'each column stacks two fields');
  assert.match(css, /\.lookup-go \{ display: grid; grid-template-rows: 1fr 1fr;/, 'button and checkbox line up with the two field rows');
  assert.match(css, /\.lookup-go button \{ width: 100%; min-width: 112px; min-height: 46px; font-size: 17px;/);
});

test('dashboard lookup: the date range filters by INVOICE date, works alone and with a name; a reversed range is flipped (owner, 18/10)', async () => {
  const sup = await db.one("SELECT id FROM suppliers WHERE name = 'טרה'", []);
  for (const [n, d, a] of [['77001', '2026-09-20', 41000], ['77002', '2026-10-05', 42000], ['77003', '2026-10-16', 43000]]) {
    await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: n, invoiceDate: d, amountBeforeVat: a, vatAmount: 0, docType: 'tax_invoice' }, o, db);
  }
  const found = (html) => ['77001', '77002', '77003'].filter((n) => html.includes(`>${n}<`));
  assert.deepEqual(found(await page('?from=2026-10-01&to=2026-10-31')), ['77002', '77003'], 'dates alone list the invoices in range');
  assert.deepEqual(found(await page('?from=2026-10-31&to=2026-10-01')), ['77002', '77003'], 'from > to is flipped, not empty');
  assert.deepEqual(found(await page('?name=' + encodeURIComponent('טרה') + '&from=2026-10-10')), ['77003'], 'name + from');
  assert.deepEqual(found(await page('?to=2026-09-30')), ['77001'], 'to alone');
  const html = await page('?from=2026-10-01&to=bad');
  assert.match(html, /<input type="hidden" name="from" value="2026-10-01"|name="from" value="2026-10-01"/, 'the chosen dates stay in the fields');
  assert.doesNotMatch(html, /name="to" value="bad"/, 'a malformed date is ignored');
});

test('dashboard: the name field finds by supplier, the number field by invoice number — not across', { skip: !!process.env.TEST_PG }, async () => {
  const byName = await page('?name=' + encodeURIComponent('טרה'));
  assert.match(byName, /תוצאות חיפוש/);
  assert.match(byName, /55012/);
  assert.match(byName, /ספקים \(1\)/);
  const byNumber = await page('?q=55012');
  assert.match(byNumber, /חשבוניות \(1\)/);
  assert.doesNotMatch(byNumber, /ספקים \(/, 'a number search does not list suppliers');
  const nameAsNumber = await page('?q=' + encodeURIComponent('טרה'));
  assert.match(nameAsNumber, /אין חשבוניות תואמות/, 'a supplier name in the number field matches nothing');
});

test('dashboard template: the untracked-transfers card is collapsed and at the bottom', () => {
  const t = readFileSync(new URL('../src/views/dashboard.ejs', import.meta.url), 'utf8');
  const i = t.indexOf('id="untracked-transfers"');
  assert.match(t, /<details class="card collapse" id="untracked-transfers"/);
  assert.ok(i > t.indexOf('דוחות Z</h2>'), 'after the last card');
});

test('outstanding checks: amount before due date, and "mark cleared" apart from "edit invoice"', () => {
  const t = readFileSync(new URL('../src/views/reports/outstanding.ejs', import.meta.url), 'utf8');
  assert.ok(t.indexOf('<th class="right">סכום</th><th>תאריך פירעון</th>') > 0, 'the columns swapped');
  const clear = t.indexOf('✓ סמן כנפרע');
  const edit = t.indexOf('✏️ ערוך');
  assert.ok(clear > 0 && edit > clear);
  assert.ok(t.slice(clear, edit).includes('</td>'), 'separate cells');
});

test('dashboard lookup: the supplier-name field suggests names that narrow with each letter — only suppliers of the active store (owner, 18/10)', async () => {
  const other = await db.one('SELECT id FROM stores WHERE id <> ? ORDER BY id LIMIT 1', [st.id]);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק של חנות אחרת', 'approved')", []);
  const foreign = await db.one("SELECT id FROM suppliers WHERE name = 'ספק של חנות אחרת'", []);
  await db.run('INSERT INTO supplier_stores (supplier_id, store_id) VALUES (?, ?)', [foreign.id, other.id]);
  const html = await page();
  assert.match(html, /<input name="name"[^>]*data-suggest="sup-names" data-suggest-submit/);
  const m = /<script type="application\/json" id="sup-names">([^<]*)<\/script>/.exec(html);
  assert.ok(m, 'the names travel with the page');
  const names = JSON.parse(m[1]);
  assert.ok(names.includes('טרה'), 'a shared supplier (no store links) is offered');
  assert.ok(!names.includes('ספק של חנות אחרת'), 'a supplier of another store is not');
  const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /document\.querySelectorAll\('input\[data-suggest\]'\)\.forEach\(enhance\);/);
  assert.match(footer, /input\.addEventListener\('input', render\);/, 're-filtered on every letter');
  assert.match(footer, /else if \(e\.key === 'Enter'\) \{ if \(idx >= 0\) \{ e\.preventDefault\(\); pick\(shown\[idx\]\); \} else close\(\); \}/, 'Enter without a pick searches what was typed');
  assert.match(footer, /window\.apPlacePopup = function \(pop, input\) \{/, 'one placement shared with js-combo');
});

test('dashboard: "Z ללא הצהרת הפקדה" is a red count beside the "דוחות Z" heading, not a tile; the lookup grows into its place (owner, 18/10)', async () => {
  const before = await page();
  assert.doesNotMatch(before, /<div class="label">Z ללא הצהרת הפקדה<\/div>/, 'the tile is gone');
  assert.doesNotMatch(before, /z-nodep-badge/, 'no badge while every Z has a declaration');
  await createZReport({ storeId: st.id, zNumber: '9101', zDate: '2026-10-15', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  const html = await page();
  assert.match(html, /<h2 style="margin:0 0 \.5rem" data-ckey="דוחות Z">דוחות Z <a class="badge b-blocked z-nodep-badge" href="\/reports\/zreports"[^>]*>1 ללא הצהרת הפקדה<\/a><\/h2>/, 'red, after the title (= on its left), the number follows the count');
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /@container \(min-width: 768px\) \{ \.stat-grid \.lookup-tile \{ grid-column: span 3; \} \}/);
  const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /var key = \(h\.getAttribute\('data-ckey'\) \|\| h\.textContent \|\| ''\)/, 'a changing count does not reset the card\'s collapsed state');
});

test('dashboard tiles: "נמשכו נתונים מהבנק" (was "התאמת בנק אחרונה") swapped with "ספקים ממתינים לאישור"; it shows when bank data last arrived (owner, 18/10)', async () => {
  const before = await page();
  assert.doesNotMatch(before, /התאמת בנק אחרונה/);
  const iOut = before.indexOf('צ׳קים בחוץ ·');
  const iPull = before.indexOf('נמשכו נתונים מהבנק');
  const iHold = before.indexOf('>חשבוניות מוחזקות<');
  const iPend = before.indexOf('>ספקים ממתינים לאישור<');
  assert.ok(iOut > 0 && iPull > iOut && iHold > iPull && iPend > iHold, 'order: checks out · bank pull · on hold · pending suppliers');
  assert.equal(await lastBankPullFor(null, st.id, db), null, 'nothing pulled yet');
  const acct = await accountForStore(db, st.id);
  await importTransactions(acct.id, [{ txnDate: '2026-10-01', amount: -12345, description: 'משיכה' }], 'manual', o, db);
  const pull = await lastBankPullFor(null, st.id, db);
  assert.ok(pull && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(pull.ts), 'the import time, not a transaction date');
  const html = await page();
  assert.match(html, /<a class="stat" href="\/reconciliation" title="נמשכו נתונים מהבנק: \d{2}\/\d{2}\/\d{2} \d{2}:\d{2}">[\s\S]*?<div class="num">\d{2}\/\d{2}\/\d{2}<\/div>/, 'date on the tile, full Israel time on hover');
  assert.doesNotMatch(html, /<div class="(num|value)"[^>]*style="[^"]*font-size/, 'every tile number has the same size (owner, 18/10)');
});
