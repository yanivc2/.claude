// בעלים 22/10, דף החשבונית: "יש חוסר סדר — נתון מתחת לנתון ואז עמודה שמאלה שוב נתון מתחת לנתון".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createInvoice } from '../src/services/invoices.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';

let db, o, st, inv, server, base;
before(async () => {
  db = await freshDb(); o = await owner(db); st = await firstStore(db);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק פרטים' }, o, db)).id, o, db);
  await createInvoice({ supplierId: sup.id, storeId: st.id, invoiceNumber: 'F-1', invoiceDate: '2026-09-22', amountBeforeVat: 100593, vatAmount: 18107, docType: 'tax_invoice', allocationNumber: '123456789' }, o, db);
  inv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'F-1'", []);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('the invoice facts are one column-ordered grid: מספר/הקצאה · ספק/סוג · חנות/תאריך · סה"כ/פירוט', async () => {
  const html = await (await fetch(`${base}/invoices/${inv.id}`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
  const g = html.slice(html.indexOf('<div class="inv-facts">'), html.indexOf('</div>\n</div>', html.indexOf('<div class="inv-facts">')));
  const labels = [...g.matchAll(/<span class="text-muted">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['מספר חשבונית', 'מספר הקצאה', 'ספק', 'סוג', 'חנות', 'תאריך', 'סה"כ', 'לפני מע"מ · מע"מ']);
  assert.doesNotMatch(html, /<div class="row" style="margin-top:\.8rem">\s*<div><span class="text-muted">מספר הקצאה/, 'the old second flex row is gone');
});
