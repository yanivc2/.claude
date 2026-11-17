// בעלים 17/11 (צילום): ₪843 לטרה מהקופה (סגירת Z 2207, 20/10), והחלון אומר "יש חשבונית של טרה מאותם ימים,
// אבל היא לא פתוחה לתשלום: #62353 ₪843.00 (כבר שולמה)" — בלי לומר למה אינה ברשימה. עכשיו הוא אומר איך:
// מהבנק (צ׳ק/העברה — לא מוצעת, הייתה נרשמת פעמיים) או במזומן שכבר הותאם להוצאה אחרת (ההוצאה כנראה כפולה).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { unmatchedCashExpenses, withMatchCandidates, matchCashExpenseToInvoice } from '../src/services/zreports.js';
import { israelToday, addDaysIso } from '../src/lib/loginHours.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

const day = addDaysIso(israelToday(), -3);

async function world() {
  const x = await freshDb();
  const ow = await owner(x);
  const store = await firstStore(x);
  const ba = await x.one('SELECT id FROM bank_accounts WHERE store_id = ?', [store.id]);
  await x.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  const sup = (await x.one("SELECT id FROM suppliers WHERE name = 'טרה'", [])).id;
  const inv = async (num, agorot, method) => {
    await createInvoice({ supplierId: sup, storeId: store.id, invoiceNumber: num, invoiceDate: day,
      amountBeforeVat: agorot, vatAmount: 0, docType: 'tax_invoice', confirm: true }, ow, x);
    const row = await x.one('SELECT * FROM invoices WHERE invoice_number = ?', [num]);
    await approveInvoiceForPayment(row.id, ow, x);
    if (method === 'cash') await createPayment({ bankAccountId: ba.id, method: 'cash', payerName: 'סבטה', paymentDate: day, invoiceIds: [row.id] }, ow, x);
    if (method === 'check') await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '70707', paymentDate: day, invoiceIds: [row.id] }, ow, x);
    return x.one('SELECT * FROM invoices WHERE id = ?', [row.id]);
  };
  const zr = await x.run("INSERT INTO z_reports (store_id,z_number,z_date,daily_total,drawer_cash,created_by) VALUES (?,'2207',?,0,0,?)", [store.id, day, ow.id]);
  const expense = async (agorot) => Number((await x.run(
    "INSERT INTO z_expenses (z_report_id,expense_date,payer_name,purpose,description_type,amount) VALUES (?,?,'סבטה','טרה','manual',?)",
    [zr.lastInsertRowid, day, agorot])).lastInsertRowid);
  const rowFor = async (id) => (await withMatchCandidates((await unmatchedCashExpenses(null, 50, null, x)).filter((r) => Number(r.id) === id), null, null, x))[0];
  const page = async () => {
    const server = createApp().listen(0); await once(server, 'listening');
    try {
      return await (await fetch(`http://127.0.0.1:${server.address().port}/payments`, { headers: { cookie: `session=${createSession(ow.id)}` } })).text();
    } finally { server.close(); }
  };
  return { x, ow, inv, expense, rowFor, page };
}

test('paid by check: not offered, and the dialog says it was paid from the bank — which check, cleared or not', async () => {
  const { inv, expense, rowFor, page } = await world();
  const terra = await inv('62353', 84300, 'check');
  const e = await expense(84300);
  const row = await rowFor(e);
  assert.ok(!row.candidates.some((c) => Number(c.id) === Number(terra.id)), 'bank money is not register money');
  const ck = row.supplierCheck.find((k) => k.supplier === 'טרה');
  assert.equal(ck.status, 'notOpen');
  assert.equal(ck.invoices[0].payments[0].method, 'check');
  assert.deepEqual(ck.invoices[0].matchedTo, []);
  const html = await page();
  assert.match(html, /#62353 שולמה מהבנק —\s*<a href="\/payments\/\d+">צ׳ק 70707<\/a> [\d/]+ \(עוד לא נפרע\)/);
  assert.match(html, /זה תשלום כפול, או שאמצעי התשלום נרשם בטעות/);
});

test('paid in cash and already matched to another expense: it names that Z, and says this one is likely a duplicate', async () => {
  const { x, ow, inv, expense, rowFor, page } = await world();
  const terra = await inv('62353', 84300, 'cash');
  const first = await expense(84300);
  await matchCashExpenseToInvoice('zreport', first, String(terra.id), ow, null, x);
  const second = await expense(84300);
  const row = await rowFor(second);
  const ck = row.supplierCheck.find((k) => k.supplier === 'טרה');
  assert.equal(ck.status, 'notOpen');
  assert.equal(ck.invoices[0].matchedTo.length, 1);
  assert.equal(ck.invoices[0].matchedTo[0].id, first);
  assert.equal(ck.invoices[0].matchedTo[0].z_number, '2207');
  const html = await page();
  assert.match(html, /#62353 <strong>כבר הותאמה להוצאת מזומן אחרת<\/strong>:\s*<a href="\/reports\/zreports\/\d+">Z 2207<\/a>/);
  assert.match(html, /ההוצאה הזו כפולה: סמן אותה "✓ טופל"/);
});

test('a voided payment is not a reason: the explanation lists only live payments', async () => {
  const { x, inv, expense, rowFor } = await world();
  const terra = await inv('62353', 84300, 'check');
  const p = await x.one('SELECT payment_id FROM payment_lines WHERE invoice_id = ?', [terra.id]);
  await x.run("UPDATE payments SET status = 'voided' WHERE id = ?", [p.payment_id]); // status left 'paid' on purpose
  await x.run("UPDATE invoices SET status = 'paid' WHERE id = ?", [terra.id]);
  const row = await rowFor(await expense(84300));
  const ck = row.supplierCheck.find((k) => k.supplier === 'טרה');
  assert.deepEqual(ck.invoices[0].payments, []);
});
