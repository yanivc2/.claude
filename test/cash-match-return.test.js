// בעלים 17/11: "כשאני מבצע התאמה (מרקורים - שולם מהפדיון) זה מעביר אותי ללוח הבקרה. אני רוצה שזה ישאיר
// אותי בדיוק באותו המקום". "התאם" (חשבונית / צ׳ק שכר) חוזר לדף שממנו נלחץ — כמו "סמן כטופל" — ולכן
// footer.ejs משחזר את הגלילה ואת הרשימות הפתוחות. רק נתיב פנימי; כל דבר אחר → "/".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { israelToday, addDaysIso } from '../src/lib/loginHours.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

const day = addDaysIso(israelToday(), -2);
let db, o, st, server, base, zr, sup;
before(async () => {
  db = await freshDb(); o = await owner(db); st = await firstStore(db);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  sup = (await db.one("SELECT id FROM suppliers WHERE name = 'טרה'", [])).id;
  zr = (await db.run("INSERT INTO z_reports (store_id,z_number,z_date,daily_total,drawer_cash,created_by) VALUES (?,'3333',?,0,0,?)", [st.id, day, o.id])).lastInsertRowid;
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const expense = async (agorot) => Number((await db.run(
  "INSERT INTO z_expenses (z_report_id,expense_date,payer_name,purpose,description_type,amount) VALUES (?,?,'סבטה','טרה','manual',?)",
  [zr, day, agorot])).lastInsertRowid);
const invoice = async (num, agorot) => {
  await createInvoice({ supplierId: sup, storeId: st.id, invoiceNumber: num, invoiceDate: day,
    amountBeforeVat: agorot, vatAmount: 0, docType: 'tax_invoice', confirm: true }, o, db);
  const row = await db.one('SELECT id FROM invoices WHERE invoice_number = ?', [num]);
  await approveInvoiceForPayment(row.id, o, db);
  return row.id;
};
const post = (path, fields) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie: `session=${createSession(o.id)}`, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
});

test('"התאם" from מרקורים returns to /payments, not the dashboard — and the match is done', async () => {
  const e = await expense(41000);
  const inv = await invoice('R-1', 41000);
  const r = await post(`/cash-expenses/zreport/${e}/match-invoice`, { invoice_ids: String(inv), return_to: '/payments' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/payments');
  const row = await db.one('SELECT invoice_id, description_type FROM z_expenses WHERE id = ?', [e]);
  assert.equal(Number(row.invoice_id), Number(inv));
  assert.equal(row.description_type, 'invoice');
});

test('an error stays on /payments too, with the message', async () => {
  const e = await expense(5000);
  const r = await post(`/cash-expenses/zreport/${e}/match-invoice`, { invoice_ids: '999999', return_to: '/payments' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/payments\?cashErr=/);
  const html = await (await fetch(base + r.headers.get('location'), { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /class="alert alert-warn"/, 'the message is shown on מרקורים');
});

test('the salary match returns to its page as well', async () => {
  const e = await expense(7000);
  const r = await post(`/cash-expenses/zreport/${e}/match-salary`, { salary_payment_id: '999999', return_to: '/payments' });
  assert.equal(r.status, 303);
  assert.match(r.headers.get('location'), /^\/payments\?cashErr=/);
});

test('from the dashboard (or with no return_to) → "/"; an outside address is never followed', async () => {
  for (const [rt, want] of [['/', '/'], [undefined, '/'], ['//evil.example', '/'], ['/\\evil.example', '/'], ['https://evil.example', '/']]) {
    const e = await expense(1234);
    const inv = await invoice(`R-${Math.random().toString(36).slice(2, 8)}`, 1234);
    const fields = { invoice_ids: String(inv) };
    if (rt !== undefined) fields.return_to = rt;
    const r = await post(`/cash-expenses/zreport/${e}/match-invoice`, fields);
    assert.equal(r.headers.get('location'), want, String(rt));
  }
});

test('both match forms carry return_to (the settle form already did)', () => {
  const v = readFileSync(new URL('../src/views/partials/_unmatchedCash.ejs', import.meta.url), 'utf8');
  for (const action of ['match-invoice', 'match-salary']) {
    const at = v.indexOf(`/${action}"`);
    const form = v.slice(at, v.indexOf('</form>', at));
    assert.match(form, /<input type="hidden" name="return_to" value="<%= _returnTo %>" \/>/, action);
  }
  const p = readFileSync(new URL('../src/views/payments/index.ejs', import.meta.url), 'utf8');
  assert.match(p, /returnTo: '\/payments'/);
});
