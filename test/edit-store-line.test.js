// בעלים, 20/10 — אחרי עריכת סגירת Z: "כן, תסדר גם את מסכי העריכה". בעריכת חשבונית ובעריכת דוח Z החנות
// אינה שדה בטופס אלא שורה קטנה בראש הטופס — "חנות: X" — ולבעלי view_all_stores קישור "העבר לחנות אחרת"
// שפותח את הבורר. partials/_storeField יודע להציג רק את זה, כך שמסך עריכה חדש לא יחזיר שדה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice } from '../src/services/invoices.js';
import { createZReport } from '../src/services/zreports.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('every edit screen puts the store in the small line at the top of its form — never as a field', () => {
  for (const p of ['src/views/zclosing/edit.ejs', 'src/views/invoices/edit.ejs', 'src/views/reports/_zform.ejs']) {
    const v = read(p).replace(/<%#[\s\S]*?%>/g, '');
    const inc = v.indexOf("include('../partials/_storeField'");
    assert.ok(inc > 0, `${p}: uses the store line`);
    const open = v.lastIndexOf('<p class="muted edit-meta">', inc);
    assert.ok(open > 0 && v.indexOf('</p>', open) > inc, `${p}: inside <p class="muted edit-meta">`);
    assert.ok(v.indexOf('<form') < open, `${p}: inside the form, so store_id + ctx_store post`);
  }
  const partial = read('src/views/partials/_storeField.ejs').replace(/<%#[\s\S]*?%>/g, '');
  assert.doesNotMatch(partial, /<label|readonly/, 'the partial renders a line of text, not a field');
});

let db, o, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const page = async (p) => (await fetch(`${base}${p}`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=3` } })).text();
const metaOf = (html) => {
  const at = html.indexOf('class="muted edit-meta"');
  assert.ok(at > 0, 'the store line is on the page');
  return html.slice(at, html.indexOf('</p>', at));
};

test('invoice and Z report edits: "חנות: X" + a hidden move picker that posts the record\'s own store', async () => {
  const name3 = (await db.one('SELECT name FROM stores WHERE id = 3', [])).name;
  const sup = await approveSupplier((await createSupplier({ name: 'ספק שורת חנות' }, o, db)).id, o, db);
  await createInvoice({ supplierId: sup.id, storeId: 3, invoiceNumber: 'ESL-1', invoiceDate: '2026-10-01',
    amountBeforeVat: 10000, vatAmount: 1800, docType: 'tax_invoice' }, o, db);
  const inv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'ESL-1'", []);
  const zr = await createZReport({ storeId: 3, zNumber: '7781', zDate: '2026-10-01', dailyTotal: 10000, drawerCash: 10000 }, o, db);
  for (const p of [`/invoices/${inv.id}/edit`, `/reports/zreports/${zr.id}`]) {
    const html = await page(p);
    const meta = metaOf(html);
    assert.match(meta, new RegExp(`<span class="sf-inline">חנות: <strong>${name3} · `), `${p}: the store as text`);
    assert.match(meta, /<span class="sf-move-link">· <button type="button" class="sf-move-btn"/, `${p}: the move link`);
    assert.match(meta, /<span class="sf-move" hidden>/, `${p}: the picker starts hidden`);
    assert.match(meta, /<option value="3" selected>/, `${p}: and holds the record's store`);
    assert.doesNotMatch(html, /<label>חנות/, `${p}: no store field in the form`);
  }
});
