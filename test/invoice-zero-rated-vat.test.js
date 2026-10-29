// בעלים 25/10: "ספקים שמסומנים ללא מע"מ — כמו ירקות — אין מספר הקצאה וזה לא נותן להתקדם עם החשבונית".
// טופס החשבונית חישב תמיד 18% מע"מ, ולכן חשבונית ירקות גדולה נשמרה עם מע"מ שאין לה ונעצרה על R3 (שנבדק
// לפי המע"מ). עכשיו ספק "עסקאות בשיעור אפס" מקבל מע"מ 0 בטופס, ובחשבונית שכבר נעצרה — הסבר איך לתקן.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createInvoice } from '../src/services/invoices.js';
import { toAgorot } from '../src/lib/money.js';

let db, o, st, veg, reg, server, base;
before(async () => {
  db = await freshDb(); o = await owner(db); st = await firstStore(db);
  await db.run("INSERT INTO suppliers (name, status, zero_rated) VALUES ('ירקות השדה', 'approved', 1)", []);
  await db.run("INSERT INTO suppliers (name, status, zero_rated) VALUES ('תנובה בדיקה', 'approved', 0)", []);
  veg = await db.one("SELECT id FROM suppliers WHERE name = 'ירקות השדה'", []);
  reg = await db.one("SELECT id FROM suppliers WHERE name = 'תנובה בדיקה'", []);
  for (const s of [veg, reg]) await db.run('INSERT INTO supplier_stores (supplier_id, store_id) VALUES (?, ?)', [s.id, st.id]);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const get = async (path) => (await fetch(base + path, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();

test('the supplier picker marks zero-rated suppliers, and the VAT auto-fill uses 0 for them (new + edit)', async () => {
  const html = await get('/invoices/new');
  assert.match(html, new RegExp(`<option value="${veg.id}" data-zero=1 `));
  assert.doesNotMatch(html, new RegExp(`<option value="${reg.id}" data-zero`));
  for (const f of ['new', 'edit']) {
    const view = readFileSync(new URL(`../src/views/invoices/${f}.ejs`, import.meta.url), 'utf8');
    assert.match(view, /function rate\(\)\{ return \(zero\(\) \|\| arn\(\)\) \? 0 : STD; \}/, f); // + חשבון ארנונה (arnona.test.js)
    assert.match(view, /ספק בשיעור אפס — מע"מ 0, בלי מספר הקצאה/, f);
  }
});

test('a big zero-VAT invoice of such a supplier is not held (R3 reads the VAT)', async () => {
  const { invoice } = await createInvoice({ supplierId: veg.id, storeId: st.id, invoiceNumber: 'VEG-1', invoiceDate: '2026-10-24',
    amountBeforeVat: toAgorot('20000'), vatAmount: 0, docType: 'tax_invoice' }, o, db);
  assert.equal(invoice.status, 'recorded');
});

test('one already held with a wrongly-typed 18% VAT says how to fix it', async () => {
  const { invoice } = await createInvoice({ supplierId: veg.id, storeId: st.id, invoiceNumber: 'VEG-2', invoiceDate: '2026-10-23',
    amountBeforeVat: toAgorot('8474.58'), vatAmount: toAgorot('1525.42'), docType: 'tax_invoice' }, o, db);
  assert.equal(invoice.status, 'on_hold');
  const html = await get(`/invoices/${invoice.id}`);
  assert.match(html, /הספק מסומן <strong>"עסקאות בשיעור אפס"<\/strong> — אם בחשבונית אין מע"מ, תקן את המע"מ ל-0/);
  assert.match(html, new RegExp(`<a href="/invoices/${invoice.id}/edit">עריכה</a>`));
});
