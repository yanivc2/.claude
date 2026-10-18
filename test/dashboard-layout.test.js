// לוח הבקרה לפי בקשת הבעלים (16/10): בלי "פעולות מהירות" ("אפשרויות" עבר לשורת הכותרת, בצד ימין — 18/10),
// "צ׳קים בחוץ" במקום "צ׳קים פתוחים" ובלי בורר חנות משלו, בדיקת חשבונית באריח — חנות פעילה בלבד, שם
// ומספר בשדות נפרדים (מקלדת מספרים), "לא שולמו בלבד"; "העברה בבנק ללא תיעוד" בתחתית ומכווץ.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

test('dashboard lookup: "חפש" left of the two fields, "לא שולמו בלבד" under it, and a big button (owner, 18/10)', async () => {
  const html = await page();
  const form = html.slice(html.indexOf('class="lookup-form"'), html.indexOf('</form>', html.indexOf('class="lookup-form"')));
  const q = form.indexOf('name="q"');
  const go = form.indexOf('class="lookup-go"');
  const btn = form.indexOf('>חפש</button>');
  const unpaid = form.indexOf('לא שולמו בלבד');
  assert.ok(q > 0 && go > q && btn > go && unpaid > btn, 'fields, then a column of [חפש] over [לא שולמו בלבד]');
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /\.lookup-form \{ display: flex; flex-wrap: nowrap;/, 'one row');
  assert.match(css, /\.lookup-go \{ display: flex; flex-direction: column;/);
  assert.match(css, /\.lookup-go button \{ width: 100%; min-width: 112px; min-height: 46px; font-size: 17px;/);
});

// SQLite בלבד: חיפוש מספר מריץ גם את lookupChecks, שתת-השאילתה המתואמת שלו אינה נתמכת ב-pg-mem
// (ראה test/multi-search.test.js — אותו דילוג). ב-Postgres האמיתי היא רצה.
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
