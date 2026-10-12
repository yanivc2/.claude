// בעלים (2026-10-12): "אפשר לבחור יותר מחשבונית אחת" בשורת הוצאה במזומן, ו"פרטים" הפך ל"עבור"
// צר מתחת ל"שם". שורה אחת שולחת "12,15"; invoice_id = הראשונה (כל הקוראים הקיימים ממשיכים לעבוד),
// invoice_ids = כולן — ומי ששואל "אילו הוצאות שילמו את חשבונית X" רואה גם את השנייה.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createZReport, replaceExpenses, listExpenses, cashPaymentsForInvoice } from '../src/services/zreports.js';
import { createZClosing, listClosingExpenses } from '../src/services/zclosing.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createInvoice, listInvoices, updateInvoice } from '../src/services/invoices.js';
import { parseInvoiceIds, encodeInvoiceIds, rowInvoiceIds, cashExpenseInvoiceIdsReady } from '../src/services/cashExpenseInvoices.js';

async function world() {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const other = await x.one('SELECT * FROM stores WHERE id <> ? AND company_id = ? ORDER BY id LIMIT 1', [store.id, store.company_id])
    || await x.one('SELECT * FROM stores WHERE id <> ? ORDER BY id LIMIT 1', [store.id]);
  const sup = await approveSupplier((await createSupplier({ name: 'ספק מזומן' }, o, x)).id, o, x);
  const inv = async (n, amt) => {
    await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: n, invoiceDate: '2026-10-01', amountBeforeVat: amt, vatAmount: 0, docType: 'tax_invoice' }, o, x);
    return x.one('SELECT * FROM invoices WHERE invoice_number = ?', [n]);
  };
  return { x, o, store, other, sup, a: await inv('MX-1', 1500), b: await inv('MX-2', 792), c: await inv('MX-3', 100) };
}

test('the id list: parsed, de-duplicated, and stored with commas at both ends', () => {
  assert.deepEqual(parseInvoiceIds('12, 15,12,,x,-3,0'), [12, 15]);
  assert.deepEqual(parseInvoiceIds([7, '8']), [7, 8]);
  assert.deepEqual(parseInvoiceIds(',12,15,'), [12, 15]);
  assert.equal(encodeInvoiceIds([12, 15]), ',12,15,', 'so LIKE "%,12,%" never matches 112');
  assert.equal(encodeInvoiceIds([]), null);
  assert.deepEqual(rowInvoiceIds({ invoice_id: 9, invoice_ids: null }), [9], 'a row saved before the column');
});

test('Z report: one cash line pays two invoices — first in invoice_id, all in invoice_ids', async () => {
  const { x, o, store, a, b } = await world();
  assert.equal(await cashExpenseInvoiceIdsReady(x), true);
  const z = await createZReport({ storeId: store.id, zNumber: '7101', zDate: '2026-10-11', drawerCash: 100000 }, o, x);
  await replaceExpenses(z.id, [{ kind: 'invoice', amount: 2292, invoiceId: `${a.id},${b.id}` }], o, x);
  const [row] = await listExpenses(z.id, x);
  assert.equal(Number(row.invoice_id), a.id);
  assert.equal(row.invoice_ids, `,${a.id},${b.id},`);

  // the invoice page of the SECOND invoice shows the cash payment, and says it was shared
  const cashB = await cashPaymentsForInvoice(b.id, x);
  assert.equal(cashB.length, 1);
  assert.equal(cashB[0].shared, 2);
  assert.equal((await cashPaymentsForInvoice(a.id, x)).length, 1);

  // the invoices list counts the match on both
  const list = await listInvoices({}, x);
  const byId = new Map(list.map((r) => [r.id, r]));
  assert.equal(byId.get(a.id).cash_matches, 1);
  assert.equal(byId.get(b.id).cash_matches, 1, 'not only the first invoice of the line');
});

test('a manual line keeps no invoice even if ids were posted', async () => {
  const { x, o, store, a, b } = await world();
  const z = await createZReport({ storeId: store.id, zNumber: '7102', zDate: '2026-10-11', drawerCash: 100000 }, o, x);
  await replaceExpenses(z.id, [{ kind: 'manual', purpose: 'ניקיון', amount: 500, invoiceId: `${a.id},${b.id}` }], o, x);
  const [row] = await listExpenses(z.id, x);
  assert.equal(row.invoice_id, null);
  assert.equal(row.invoice_ids, null);
});

test('register closing: the same — and the second invoice cannot move store while linked', async () => {
  const { x, o, store, other, b, c } = await world();
  await createZClosing({
    employeeFirst: 'רון', employeeLast: 'לוי', storeId: store.id, zNumber: '7201', drawerCash: 0,
    startedAt: '2026-10-11 09:00', counts: { 200: 1 },
    expenses: [{ kind: 'invoice', expenseDate: '2026-10-11', invoiceId: `${c.id},${b.id}`, amount: 892 }],
  }, o, x);
  const id = (await x.one('SELECT id FROM z_closings ORDER BY id DESC LIMIT 1', [])).id;
  const [row] = await listClosingExpenses(id, x);
  assert.equal(Number(row.invoice_id), c.id);
  assert.equal(row.invoice_ids, `,${c.id},${b.id},`);
  if (other) {
    await assert.rejects(() => updateInvoice(b.id, { storeId: other.id }, o, x), /הוצאת מזומן/,
      'the store-move block sees the second invoice of the line too');
  }
});

test('the three forms: "עבור" (not "פרטים") with the multi picker, laid out under "שם"', () => {
  for (const f of ['src/views/reports/_zform.ejs', 'src/views/zclosing/index.ejs', 'src/views/zclosing/edit.ejs']) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!s.includes('<label>פרטים</label>'), `${f}: renamed`);
    assert.match(s, /cx-details"><label>עבור<\/label>/, `${f}: "עבור"`);
    assert.ok(!/<select name="expense_invoice_id"/.test(s), `${f}: one hidden "12,15" field per row, not a select`);
    assert.match(s, /cx-inv-picker\.js/, `${f}: loads the picker`);
    for (const c of ['cx-f-kind', 'cx-f-date', 'cx-f-name']) assert.ok(s.includes(c), `${f}: ${c}`);
  }
  const css = fs.readFileSync('src/public/nocturne.css', 'utf8');
  assert.match(css, /grid-template-areas: "kind date name \." "amt amt for del"/, '"עבור" sits under "שם"');
  assert.match(css, /\.cx-inv-box\[hidden\] \{ display: none; \}/);
});

test('🔴 before "עדכן מסד נתונים": saving still works and keeps the first invoice (no crash)', async (t) => {
  const { x, o, store, a, b } = await world();
  try {
    await x.run('ALTER TABLE z_expenses DROP COLUMN invoice_ids', []);
    await x.run('ALTER TABLE z_closing_expenses DROP COLUMN invoice_ids', []);
  } catch {
    t.skip('this dialect cannot drop a column in tests');
    return;
  }
  assert.equal(await cashExpenseInvoiceIdsReady(x), false, 'the probe says so out loud');
  const z = await createZReport({ storeId: store.id, zNumber: '7301', zDate: '2026-10-11', drawerCash: 100000 }, o, x);
  await replaceExpenses(z.id, [{ kind: 'invoice', amount: 2292, invoiceId: `${a.id},${b.id}` }], o, x);
  const [row] = await listExpenses(z.id, x);
  assert.equal(Number(row.invoice_id), a.id);
  assert.equal((await cashPaymentsForInvoice(a.id, x)).length, 1);
  assert.equal((await listInvoices({}, x)).length >= 2, true, 'the invoices list still renders');
});
