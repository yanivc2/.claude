// בעלים 17/11: "הרעיון מאחורי המרקורים הוא לבצע התאמה בין מה ששולם במזומן מהקופות ונרשם ידנית על דף לבין
// החשבונית. למה זה לא נותן לבצע את ההתאמה? ... חשבונית שולמה במזומן אז למה היא לא מופיעה? ... אין אפשרות
// לחפש במלל? והכי חשוב שהתוצאות הראשונות יהיו הסכומים הכי קרובים לסכום ששולם במזומן".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { unmatchedCashExpenses, withMatchCandidates, matchCashExpenseToInvoice } from '../src/services/zreports.js';
import { rankInvoices, NEAR_AGOROT } from '../src/lib/cashInvoiceMatch.js';
import { israelToday, addDaysIso } from '../src/lib/loginHours.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

const today = israelToday();
const day = addDaysIso(today, -3);

async function world() {
  const x = await freshDb();
  const ow = await owner(x);
  const store = await firstStore(x);
  const ba = await x.one('SELECT id FROM bank_accounts WHERE store_id = ?', [store.id]);
  for (const n of ['גלוברנדס', 'טרה', 'תנובה']) await x.run("INSERT INTO suppliers (name, status) VALUES (?, 'approved')", [n]);
  const sup = async (n) => (await x.one('SELECT id FROM suppliers WHERE name = ?', [n])).id;
  const inv = async (name, num, agorot, method) => {
    await createInvoice({ supplierId: await sup(name), storeId: store.id, invoiceNumber: num, invoiceDate: day,
      amountBeforeVat: agorot, vatAmount: 0, docType: 'tax_invoice', confirm: true }, ow, x);
    const row = await x.one('SELECT * FROM invoices WHERE invoice_number = ?', [num]);
    await approveInvoiceForPayment(row.id, ow, x);
    if (method === 'cash') await createPayment({ bankAccountId: ba.id, method: 'cash', payerName: 'זאב', paymentDate: day, invoiceIds: [row.id] }, ow, x);
    if (method === 'check') await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: `9${num.replace(/\D/g, '')}`, paymentDate: day, invoiceIds: [row.id] }, ow, x);
    return x.one('SELECT * FROM invoices WHERE id = ?', [row.id]);
  };
  const zr = await x.run('INSERT INTO z_reports (store_id,z_number,z_date,daily_total,drawer_cash,created_by) VALUES (?,\'2222\',?,0,0,?)', [store.id, day, ow.id]);
  const expense = async (payer, purpose, agorot) => Number((await x.run(
    "INSERT INTO z_expenses (z_report_id,expense_date,payer_name,purpose,description_type,amount) VALUES (?,?,?,?,'manual',?)",
    [zr.lastInsertRowid, day, payer, purpose, agorot])).lastInsertRowid);
  const rowFor = async (id) => (await withMatchCandidates((await unmatchedCashExpenses(null, 50, null, x)).filter((r) => Number(r.id) === id), null, null, x))[0];
  return { x, ow, store, inv, expense, rowFor };
}

test('an invoice already paid in cash is offered for the register cash it came from — first, ★, marked 💵', async () => {
  const { inv, expense, rowFor } = await world();
  const glob = await inv('גלוברנדס', '18527', 154170, 'cash');
  assert.equal(glob.status, 'paid', 'the cash payment marked it paid — the case from the screenshot');
  await inv('תנובה', 'T-1', 200000); // an open one with a far amount
  const exp = await expense('זאב', 'סיגריות', 154170);
  const row = await rowFor(exp);
  assert.equal(Number(row.candidates[0].id), Number(glob.id));
  assert.equal(row.candidates[0].sameAmount, true);
  assert.equal(row.candidates[0].paidCash, true);
});

test('paid by check is never offered (bank money is not register money); once matched, a cash-paid invoice leaves the list', async () => {
  const { x, ow, inv, expense, rowFor } = await world();
  const chk = await inv('טרה', 'C-5', 50000, 'check');
  const cash = await inv('טרה', 'K-5', 50000, 'cash');
  const e1 = await expense('סבטה', 'טרה', 50000);
  const r1 = await rowFor(e1);
  const ids = r1.candidates.map((c) => Number(c.id));
  assert.ok(!ids.includes(Number(chk.id)), 'check-paid → not offered');
  assert.ok(ids.includes(Number(cash.id)));
  await matchCashExpenseToInvoice('zreport', e1, String(cash.id), ow, null, x);
  const e2 = await expense('סבטה', 'טרה', 50000);
  const r2 = await rowFor(e2);
  assert.ok(!r2.candidates.some((c) => Number(c.id) === Number(cash.id)), 'already matched to the first expense');
});

test('rounding at the till: ₪1,684.00 against ₪1,683.99 is "near" (≤ ₪1) — first and pre-selected', async () => {
  const { inv, expense, rowFor } = await world();
  const terra = await inv('טרה', '87815', 168399, 'cash');
  await inv('תנובה', 'T-2', 168500);
  const exp = await expense('סבטה', 'טרה', 168400);
  const row = await rowFor(exp);
  assert.equal(Number(row.candidates[0].id), Number(terra.id));
  assert.equal(row.candidates[0].nearAmount, true);
  assert.equal(row.candidates[0].diff, 1);
  assert.equal(NEAR_AGOROT, 100);
  assert.ok(!row.supplierCheck.some((k) => k.status === 'notOpen'), 'no more "לא פתוחה לתשלום" for it');
});

test('ranking: the closest amount first, whatever the supplier or date; the named supplier and the Z day survive the limit', () => {
  const e = { amount: 154170, payer_name: 'טרה', expense_date: '2026-11-09' };
  const mk = (id, supplier_name, total_amount, invoice_date) => ({ id, supplier_name, total_amount, invoice_date });
  const r = rankInvoices(e, [
    mk(1, 'ל.א מוצרי עישון', 662800, '2026-11-03'),
    mk(2, 'גלוברנדס', 154170, '2026-11-09'),
    mk(3, 'תנובה', 150000, '2026-10-01'),
    mk(4, 'טרה', 900000, '2026-11-09'),
    mk(5, 'דוד נבון', 160000, '2026-10-29'),
  ], 3);
  assert.deepEqual(r.slice(0, 3).map((x) => x.id), [2, 3, 5], 'by |difference|: 0, 4,170, 5,830');
  assert.ok(r.some((x) => x.id === 4), 'the named supplier of the Z day stays, though far in amount and past the limit');
  assert.ok(!r.some((x) => x.id === 1), 'a far amount of another supplier and day is cut');
});

test('the dialog: a searchable picker (js-combo), closest first, 💵 and the difference spelled out', async () => {
  const { x, inv, expense } = await world();
  await inv('גלוברנדס', '18527', 154170, 'cash');
  await inv('תנובה', 'T-3', 154000);
  await expense('זאב', 'סיגריות', 154170);
  const o = await owner(x);
  const server = createApp().listen(0); await once(server, 'listening');
  try {
    const html = await (await fetch(`http://127.0.0.1:${server.address().port}/`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
    assert.match(html, /<select class="cx-inv js-combo" aria-label="הוסף חשבונית"/);
    const g = html.indexOf('★ 💵 גלוברנדס #18527');
    const t = html.indexOf('תנובה #T-3');
    assert.ok(g > 0 && t > g, 'the exact cash-paid one first, the ₪1.70-off one after it');
    assert.match(html, /תנובה #T-3 · ₪1,540\.00 · [\d/]+ · הפרש ₪1\.70/);
    assert.match(html, /נמצאה חשבונית אחת בדיוק באותו סכום — כבר נבחרה/);
  } finally { server.close(); }
});
