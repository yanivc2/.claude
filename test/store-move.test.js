// עריכה: החנות קבועה. העברה לחנות אחרת — רק עם view_all_stores (בעלים תמיד), ונחסמת כשכסף
// כבר קשור לחנות הנוכחית (תשלום מחשבון הבנק שלה, שקית הפקדה שהותאמה בבנק שלה).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setUserStores } from '../src/lib/scope.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createZReport } from '../src/services/zreports.js';

let server, base, db, o, sup;
const ck = (u, store) => `session=${createSession(u.id)}${store ? `; ap_store=${store}` : ''}`;
const post = (p, u, store, body) => fetch(`${base}${p}`, {
  method: 'POST', redirect: 'manual', headers: { cookie: ck(u, store), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
let n = 0;
async function invoiceIn(store) {
  n += 1;
  await createInvoice({ supplierId: sup.id, storeId: store, invoiceNumber: `MV-${n}`, invoiceDate: `2026-09-${String(n).padStart(2, '0')}`,
    amountBeforeVat: 10000 + n * 137, vatAmount: 1800, docType: 'tax_invoice' }, o, db);
  return db.one('SELECT * FROM invoices WHERE invoice_number = ?', [`MV-${n}`]);
}
const editBody = (inv, store) => ({
  ctx_store: String(inv.store_id), store_id: String(store), supplier_id: String(inv.supplier_id), invoice_number: inv.invoice_number,
  invoice_date: inv.invoice_date, amount_before_vat: '100', vat_amount: '18', doc_type: inv.doc_type,
});

before(async () => {
  db = await freshDb();
  o = await owner(db);
  sup = await approveSupplier((await createSupplier({ name: 'ספק העברה' }, o, db)).id, o, db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('owner moves an unpaid invoice → lands on the list with a note; the invoice is in the new store', async () => {
  const inv = await invoiceIn(3);
  const r = await post(`/invoices/${inv.id}/edit`, o, 3, editBody(inv, 4));
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `/invoices?moved=${inv.id}`);
  assert.equal(Number((await db.one('SELECT store_id FROM invoices WHERE id = ?', [inv.id])).store_id), 4);
  const list = await (await fetch(`${base}/invoices?moved=${inv.id}`, { headers: { cookie: ck(o, 3) } })).text();
  assert.match(list, new RegExp(`חשבונית #${inv.id} הועברה לחנות אחרת`));
});

test('an invoice with a live payment cannot move — the money left this store\'s account', async () => {
  const inv = await invoiceIn(3);
  await approveInvoiceForPayment(inv.id, o, db);
  // A partial payment (a payment line that does not settle the invoice): the invoice is still
  // editable, but its money already left store 3's account.
  const acct = await accountForStore(db, 3);
  const p = await db.run("INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by) VALUES (?, 'check', '8801', '2026-09-25', 5000, 'issued', ?)", [acct.id, o.id]);
  await db.run('INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, 5000)', [p.lastInsertRowid, inv.id]);
  const fresh = await db.one('SELECT * FROM invoices WHERE id = ?', [inv.id]);
  assert.notEqual(fresh.status, 'paid');
  const r = await post(`/invoices/${inv.id}/edit`, o, 3, editBody(fresh, 4));
  assert.equal(r.status, 400);
  assert.match(await r.text(), /לא ניתן להעביר אותה לחנות אחרת/);
  assert.equal(Number((await db.one('SELECT store_id FROM invoices WHERE id = ?', [inv.id])).store_id), 3);
});

test('without view_all_stores the edit form is read-only and a posted move is refused', async () => {
  const sec = await db.one("SELECT * FROM users WHERE role='secretary' LIMIT 1", []);
  await setUserStores(sec.id, [3, 4], db);
  await db.run(`UPDATE users SET permissions = '["edit_invoice"]' WHERE id = ?`, [sec.id]);
  const inv = await invoiceIn(3);
  const page = await (await fetch(`${base}/invoices/${inv.id}/edit`, { headers: { cookie: ck(sec, 3) } })).text();
  assert.ok(!/<select name="store_id" required>/.test(page), 'no move picker (the header\'s active-store picker is separate)');
  assert.match(page, /name="store_id" value="3"/);
  const r = await post(`/invoices/${inv.id}/edit`, sec, 3, editBody(inv, 4));
  assert.equal(r.status, 400);
  assert.match(await r.text(), /רק למי שיש לו הרשאת/);
  // the owner does get the picker
  const op = await (await fetch(`${base}/invoices/${inv.id}/edit`, { headers: { cookie: ck(o, 3) } })).text();
  assert.match(op, /<select name="store_id" required>/);
  assert.match(op, /שינוי החנות מעביר את הרשומה לחנות אחרת/);
});

test('a Z report moves with its unmatched deposits; a bank-matched deposit blocks the move', async () => {
  const zBody = (zr, store, zn) => ({
    ctx_store: '3', store_id: String(store), z_number: zn, z_date: '2026-10-01', daily_total: '100', drawer_cash: '100', drawer_credit: '0',
    dep_bag: '9001', dep_amount: '50',
  });
  const z1 = await createZReport({ storeId: 3, zNumber: '6601', zDate: '2026-10-01', dailyTotal: 10000, drawerCash: 10000 }, o, db);
  const r1 = await post(`/reports/zreports/${z1.id}`, o, 3, zBody(z1, 4, '6601'));
  assert.equal(r1.status, 303);
  assert.match(r1.headers.get('location'), /^\/reports\/zreports\?notice=/);
  assert.equal(Number((await db.one('SELECT store_id FROM z_reports WHERE id = ?', [z1.id])).store_id), 4);
  const dep = await db.one('SELECT * FROM deposits WHERE z_report_id = ?', [z1.id]);
  assert.equal(Number(dep.store_id), 4, 'the bag follows its report');

  const z2 = await createZReport({ storeId: 3, zNumber: '6602', zDate: '2026-10-01', dailyTotal: 10000, drawerCash: 10000 }, o, db);
  await post(`/reports/zreports/${z2.id}`, o, 3, zBody(z2, 3, '6602'));
  const acct = await accountForStore(db, 3);
  const t = await db.run("INSERT INTO bank_transactions (bank_account_id, txn_date, amount, source) VALUES (?, '2026-10-02', 5000, 'manual')", [acct.id]);
  await db.run('UPDATE deposits SET matched_txn_id = ? WHERE z_report_id = ?', [t.lastInsertRowid, z2.id]);
  const r2 = await post(`/reports/zreports/${z2.id}`, o, 3, zBody(z2, 4, '6602'));
  assert.equal(r2.status, 200);
  assert.match(await r2.text(), /הותאמה לתנועה בבנק של החנות הנוכחית/);
  assert.equal(Number((await db.one('SELECT store_id FROM z_reports WHERE id = ?', [z2.id])).store_id), 3);
});
