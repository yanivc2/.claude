// בעלים, 16/10: "היא משלמת טרה וקולה יחד ... אני לא מצליח למצוא את החשבונית המתאימה של טרה".
// הוצאה אחת ששילמה שני ספקים: אין חשבונית בודדת באותו סכום, ולכן ה-★ לא הופיע והרשימה מוינה לפי
// תאריך בלבד. עכשיו: הספק שבשם קודם, יום ה-Z קודם, צירוף שסכומו שווה בדיוק מוצע, וההתאמה יכולה
// לכלול כמה חשבוניות (גם של ספקים שונים). חשבונית שהוזנה אבל אינה פתוחה — נאמר למה היא לא ברשימה.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { mentionsSupplier, rankInvoices, invoiceCombos } from '../src/lib/cashInvoiceMatch.js';
import { withMatchCandidates, unmatchedCashExpenses, matchCashExpenseToInvoice } from '../src/services/zreports.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';

test('names: "טרה" finds the supplier, "וקוקה קולה" finds Coca-Cola (Hebrew prefix), a generic word does not', () => {
  const e = { payer_name: 'טרה', purpose: 'וקוקה קולה' };
  assert.equal(mentionsSupplier(e, 'טרה'), true);
  assert.equal(mentionsSupplier(e, 'חברת טרה בע"מ'), true, 'the generic "חברת" is skipped');
  assert.equal(mentionsSupplier(e, 'קוקה קולה ישראל'), true);
  assert.equal(mentionsSupplier(e, 'תנובה'), false);
});

test('ranking: same amount → the supplier in the name → the Z day → newer', () => {
  const e = { amount: 50000, payer_name: 'טרה', expense_date: '2026-10-14' };
  const inv = (id, supplier_name, total_amount, invoice_date) => ({ id, supplier_name, total_amount, invoice_date });
  const r = rankInvoices(e, [
    inv(1, 'תנובה', 30000, '2026-10-15'),
    inv(2, 'טרה', 30000, '2026-10-01'),
    inv(3, 'טרה', 30000, '2026-10-14'),
    inv(4, 'שטראוס', 50000, '2026-09-01'),
  ]);
  assert.deepEqual(r.map((x) => x.id), [4, 3, 2, 1]);
});

test('combos: Terra + Coca-Cola of the same day add up exactly → offered; far-off dates are not', () => {
  const e = { amount: 50000, payer_name: 'טרה', purpose: 'קוקה קולה', expense_date: '2026-10-14' };
  const inv = (id, supplier_name, total_amount, invoice_date) => ({ id, supplier_name, total_amount, invoice_date });
  const ranked = rankInvoices(e, [
    inv(1, 'טרה', 31000, '2026-10-14'),
    inv(2, 'קוקה קולה', 19000, '2026-10-14'),
    inv(3, 'תנובה', 19000, '2026-10-14'),
    inv(4, 'טרה', 19000, '2026-08-01'),
  ]);
  const combos = invoiceCombos(e, ranked);
  assert.ok(combos.length >= 1);
  assert.deepEqual(combos[0].ids.sort(), [1, 2], 'the combo naming both suppliers comes first');
  assert.ok(!combos.some((c) => c.ids.includes(4)), 'an invoice from August is not combined');
});

async function world() {
  const x = await freshDb();
  const ow = await owner(x);
  const store = await firstStore(x);
  for (const n of ['טרה', 'קוקה קולה']) await x.run("INSERT INTO suppliers (name, status) VALUES (?, 'approved')", [n]);
  const sup = async (n) => (await x.one('SELECT id FROM suppliers WHERE name = ?', [n])).id;
  const mk = async (name, num, agorot, date, approve = true) => {
    await createInvoice({ supplierId: await sup(name), storeId: store.id, invoiceNumber: num, invoiceDate: date,
      amountBeforeVat: agorot, vatAmount: 0, docType: 'tax_invoice' }, ow, x);
    const inv = await x.one('SELECT * FROM invoices WHERE invoice_number = ?', [num]);
    if (approve) await approveInvoiceForPayment(inv.id, ow, x);
    return inv;
  };
  const zr = await x.run(`INSERT INTO z_reports (store_id,z_number,z_date,daily_total,drawer_cash,created_by)
                          VALUES (?,'3300','2026-10-14',0,0,?)`, [store.id, ow.id]);
  const exp = Number((await x.run(`INSERT INTO z_expenses (z_report_id,expense_date,payer_name,purpose,description_type,amount)
                         VALUES (?, '2026-10-14','טרה','וקוקה קולה','manual',50000)`, [zr.lastInsertRowid])).lastInsertRowid);
  return { x, ow, store, mk, exp };
}

test('service: the dashboard row gets the combo, and matching it pays both invoices in one go', async () => {
  const { x, ow, mk, exp } = await world();
  const t = await mk('טרה', 'T-77', 31000, '2026-10-14');
  const c = await mk('קוקה קולה', 'C-12', 19000, '2026-10-14');
  const [row] = await withMatchCandidates((await unmatchedCashExpenses(null, 20, null, x)).filter((r) => Number(r.id) === exp), null, null, x);
  assert.equal(row.combos.length, 1);
  assert.deepEqual(row.combos[0].ids.sort((a, b) => a - b), [Number(t.id), Number(c.id)].sort((a, b) => a - b));
  assert.ok(row.supplierCheck.every((k) => k.status === 'listed'), 'both suppliers have an open invoice that day');
  await matchCashExpenseToInvoice('zreport', exp, row.combos[0].ids.join(','), ow, null, x);
  const e = await x.one('SELECT invoice_id, invoice_ids, description_type FROM z_expenses WHERE id = ?', [exp]);
  assert.equal(e.description_type, 'invoice');
  assert.equal(e.invoice_ids, `,${row.combos[0].ids.join(',')},`);
  assert.ok(!(await unmatchedCashExpenses(null, 20, null, x)).some((r) => Number(r.id) === exp), 'off the list');
});

test('service: no Terra invoice that day → said out loud; a Terra invoice that is already paid → said why it is missing', async () => {
  const { x, store, mk, exp } = await world();
  let [row] = await withMatchCandidates((await unmatchedCashExpenses(null, 20, null, x)).filter((r) => Number(r.id) === exp), null, null, x);
  assert.deepEqual(row.supplierCheck.map((k) => [k.supplier, k.status]).sort(), [['טרה', 'missing'], ['קוקה קולה', 'missing']],
    'no invoice of either supplier was entered → said, even with no invoice of theirs anywhere near');
  const t = await mk('טרה', 'T-90', 31000, '2026-10-14', false);
  await x.run("UPDATE invoices SET status = 'paid' WHERE id = ?", [t.id]);
  await mk('קוקה קולה', 'C-90', 19000, '2026-10-01');
  [row] = await withMatchCandidates((await unmatchedCashExpenses(null, 20, null, x)).filter((r) => Number(r.id) === exp), null, null, x);
  const terra = row.supplierCheck.find((k) => k.supplier === 'טרה');
  assert.equal(terra.status, 'notOpen');
  assert.equal(terra.invoices[0].invoice_number, 'T-90');
  const cola = row.supplierCheck.find((k) => k.supplier === 'קוקה קולה');
  assert.equal(cola.status, 'missing', 'the only Coca-Cola invoice is two weeks earlier');
  assert.ok(store);
});

test('service: an invoice of another store cannot be slipped into the match', async () => {
  const { x, ow, exp } = await world();
  const other = await x.one('SELECT id FROM stores ORDER BY id DESC LIMIT 1', []);
  const first = await firstStore(x);
  if (Number(other.id) === Number(first.id)) return;
  const sup = (await x.one("SELECT id FROM suppliers WHERE name = 'טרה'", [])).id;
  await createInvoice({ supplierId: sup, storeId: other.id, invoiceNumber: 'X-1', invoiceDate: '2026-10-14', amountBeforeVat: 50000, vatAmount: 0, docType: 'tax_invoice' }, ow, x);
  const foreign = await x.one("SELECT id FROM invoices WHERE invoice_number = 'X-1'", []);
  await assert.rejects(() => matchCashExpenseToInvoice('zreport', exp, String(foreign.id), ow, { companyIds: null, storeIds: [first.id] }, x), /לא נמצאה/);
});

test('"הותאם ל": a matched expense lists what it paid, each linking to its invoice', async () => {
  const { x, ow, mk, exp } = await world();
  const t = await mk('טרה', 'T-55', 31000, '2026-10-14');
  const c = await mk('קוקה קולה', 'C-55', 19000, '2026-10-14');
  await matchCashExpenseToInvoice('zreport', exp, `${t.id},${c.id}`, ow, null, x);
  const { matchedCashExpenses } = await import('../src/services/zreports.js');
  const [m] = (await matchedCashExpenses(null, 20, null, x)).filter((r) => Number(r.id) === exp);
  assert.deepEqual(m.matchedTo.map((k) => k.href), [`/invoices/${t.id}`, `/invoices/${c.id}`]);
  assert.match(m.matchedTo[0].label, /#T-55 · טרה/);
  assert.equal(m.source, 'zreport');
});

test('WhatsApp numbers: Israeli mobile → wa.me format; junk → null', async () => {
  const { waPhone } = await import('../src/services/cashPanel.js');
  assert.equal(waPhone('050-123-4567'), '972501234567');
  assert.equal(waPhone('+972 50 123 4567'), '972501234567');
  assert.equal(waPhone('12'), null);
  assert.equal(waPhone(null), null);
});
