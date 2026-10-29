// 🏛️ חשבון ארנונה (בעלים 29/10): "במקום מספר חשבונית צריך מספר נכס ומספר מסלקה. במקום תאריך צריך טווח
// תאריכים (זה דו חודשי)". החלטות הבעלים: אפשרות ב"סוג מסמך", הקלדה בכל פעם, מחודש עד חודש, בלי "לתשלום עד".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createInvoice, updateInvoice, getInvoice, arnonaFields, arnonaReady } from '../src/services/invoices.js';
import { arnonaMonth, arnonaPeriodLabel } from '../src/lib/arnona.js';
import { invoiceEditMatches, describeInvoice } from '../src/lib/changeSummary.js';
import { getCheckPrintData, createPayment } from '../src/services/payments.js';
import { migrate } from '../src/db/migrate.js';
import { toAgorot } from '../src/lib/money.js';

let db, o, st, city, server, base;
before(async () => {
  db = await freshDb(); o = await owner(db); st = await firstStore(db);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('עיריית הרצליה', 'approved')", []);
  city = await db.one("SELECT id FROM suppliers WHERE name = 'עיריית הרצליה'", []);
  await db.run('INSERT INTO supplier_stores (supplier_id, store_id) VALUES (?, ?)', [city.id, st.id]);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const ck = (u) => `session=${createSession(u.id)}; ap_store=${st.id}`;
const get = async (path, u = o) => (await fetch(base + path, { headers: { cookie: ck(u) } })).text();
const bill = (over = {}) => ({
  supplierId: city.id, storeId: st.id, docType: 'arnona',
  propertyNumber: '6532008800300', clearingNumber: '1013852007', periodFrom: '2026-09', periodTo: '2026-10',
  amountBeforeVat: toAgorot('1440.20'), vatAmount: 0, ...over,
});

test('the period reads like the bill: 09-10/26, across a year 12/26-01/27, one month 09/26', () => {
  assert.equal(arnonaPeriodLabel('2026-09', '2026-10'), '09-10/26');
  assert.equal(arnonaPeriodLabel('2026-12-01', '2027-01-01'), '12/26-01/27');
  assert.equal(arnonaPeriodLabel('2026-09', '2026-09'), '09/26');
  // the month picker posts YYYY-MM-01; a typed 9/26 or 09/2026 is understood too
  assert.equal(arnonaMonth('2026-09-01'), '2026-09');
  assert.equal(arnonaMonth('9/26'), '2026-09');
  assert.equal(arnonaMonth('09/2026'), '2026-09');
  assert.equal(arnonaMonth('2026-13'), null);
});

test('arnonaFields: both numbers required, the period ordered and at most 12 months', () => {
  assert.throws(() => arnonaFields({ clearingNumber: '1', periodFrom: '2026-09', periodTo: '2026-10' }), /חסר מספר נכס/);
  assert.throws(() => arnonaFields({ propertyNumber: '1', periodFrom: '2026-09', periodTo: '2026-10' }), /חסר מספר מסלקה/);
  assert.throws(() => arnonaFields({ propertyNumber: '1', clearingNumber: '2', periodFrom: '2026-09' }), /מחודש ועד חודש/);
  assert.throws(() => arnonaFields({ propertyNumber: '1', clearingNumber: '2', periodFrom: '2026-10', periodTo: '2026-09' }), /לפני חודש ההתחלה/);
  assert.throws(() => arnonaFields({ propertyNumber: '1', clearingNumber: '2', periodFrom: '2026-01', periodTo: '2027-01' }), /13 חודשים/);
});

test('a bill is saved with property + clearing + period; number and date are derived, no VAT, never R3-held', async () => {
  assert.equal(await arnonaReady(db), true);
  // a large amount with VAT typed by mistake: the VAT folds into the total, the bill is not held for an allocation number
  const { invoice } = await createInvoice(bill({ amountBeforeVat: toAgorot('8000'), vatAmount: toAgorot('1440'), periodFrom: '2026-11', periodTo: '2026-12' }), o, db);
  assert.equal(invoice.doc_type, 'arnona');
  assert.equal(invoice.invoice_number, 'ארנונה 11-12/26 · נכס 6532008800300');
  assert.equal(invoice.invoice_date, '2026-11-01');
  assert.equal(invoice.vat_amount, 0);
  assert.equal(invoice.total_amount, toAgorot('9440'));
  assert.equal(invoice.allocation_number, null);
  assert.equal(invoice.status, 'recorded');
  const row = await getInvoice(invoice.id, db);
  assert.deepEqual([row.property_number, row.clearing_number, row.period_from, row.period_to],
    ['6532008800300', '1013852007', '2026-11', '2026-12']);
});

test('the same property and period again is flagged as a duplicate (R2); the next period is not', async () => {
  await createInvoice(bill(), o, db);
  await assert.rejects(createInvoice(bill(), o, db), (e) => e.rule === 'WARN' && e.meta.warnings.some((w) => w.code === 'R2'));
  const next = await createInvoice(bill({ periodFrom: '2027-01', periodTo: '2027-02' }), o, db);
  assert.deepEqual(next.warnings, []);
});

test('editing: a new period re-derives the number; switching to a tax invoice clears the bill fields', async () => {
  const { invoice } = await createInvoice(bill({ propertyNumber: '777', periodFrom: '2027-03', periodTo: '2027-04' }), o, db);
  await updateInvoice(invoice.id, { docType: 'arnona', periodFrom: '2027-05-01', periodTo: '2027-06-01', amountBeforeVat: toAgorot('500'), vatAmount: 0 }, o, db);
  let row = await getInvoice(invoice.id, db);
  assert.equal(row.invoice_number, 'ארנונה 05-06/27 · נכס 777');
  assert.equal(row.invoice_date, '2027-05-01');
  assert.equal(row.clearing_number, '1013852007', 'a field not sent keeps its value');
  await updateInvoice(invoice.id, { docType: 'tax_invoice', invoiceNumber: 'T-1', invoiceDate: '2027-05-03', amountBeforeVat: toAgorot('500'), vatAmount: toAgorot('90') }, o, db);
  row = await getInvoice(invoice.id, db);
  assert.equal(row.invoice_number, 'T-1');
  assert.deepEqual([row.property_number, row.clearing_number, row.period_from, row.period_to], [null, null, null, null]);
});

test('a change request compares the bill fields, and describes them in Hebrew', async () => {
  const { invoice } = await createInvoice(bill({ propertyNumber: '888', periodFrom: '2027-07', periodTo: '2027-08' }), o, db);
  const cur = await getInvoice(invoice.id, db);
  const same = { supplierId: city.id, storeId: st.id, docType: 'arnona', propertyNumber: '888', clearingNumber: '1013852007',
    periodFrom: '2027-07-01', periodTo: '2027-08-01', amountBeforeVat: toAgorot('1440.20'), vatAmount: 0 };
  assert.equal(invoiceEditMatches(cur, same), true, 'the disabled number/date fields do not count as a change');
  const moved = { ...same, periodTo: '2027-09-01' };
  assert.equal(invoiceEditMatches(cur, moved), false);
  const text = describeInvoice({ ...cur, supplier_name: 'עיריית הרצליה' }, moved);
  assert.match(text, /תקופה: 07-08\/27 ← 07-09\/27/);
  assert.doesNotMatch(text, /מספר חשבונית/);
});

test('the form offers "חשבון ארנונה" and swaps the number/date row for the bill row in place', async () => {
  const html = await get('/invoices/new');
  assert.match(html, /<option value="arnona" >חשבון ארנונה<\/option>/);
  assert.match(html, /<div class="row" data-doc-std>/);
  assert.match(html, /<div class="row" data-doc-arnona style="display:none">/);
  for (const n of ['property_number', 'clearing_number']) assert.match(html, new RegExp(`name="${n}" required`));
  assert.match(html, /name="period_from" data-dp-mode="month" required/);
  assert.match(html, /name="period_to" data-dp-mode="month" required/);
  // the hidden row is disabled (not posted, not "required"), incl. the enhanced date field's data-req
  const part = readFileSync(new URL('../src/views/invoices/_arnonaFields.ejs', import.meta.url), 'utf8');
  assert.match(part, /el\.disabled = !on/);
  assert.match(part, /delete w\.dataset\.req/);
  for (const f of ['new', 'edit']) {
    const view = readFileSync(new URL(`../src/views/invoices/${f}.ejs`, import.meta.url), 'utf8');
    assert.match(view, /include\('_arnonaFields'\)/, f);
    assert.match(view, /function rate\(\)\{ return \(zero\(\) \|\| arn\(\)\) \? 0 : STD; \}/, f);
  }
});

test('posting the form saves the bill and its page shows property, clearing and period', async () => {
  const fd = new FormData();
  const fields = { ctx_store: st.id, store_id: st.id, supplier_id: city.id, doc_type: 'arnona', property_number: '6532008800300',
    clearing_number: '1013852007', period_from: '2028-09-01', period_to: '2028-10-01', amount_before_vat: '1440.20', vat_amount: '0' };
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const r = await fetch(`${base}/invoices`, { method: 'POST', redirect: 'manual', headers: { cookie: ck(o) }, body: fd });
  assert.equal(r.status, 303, await r.text());
  const row = await db.one("SELECT * FROM invoices WHERE period_from = '2028-09'", []);
  assert.ok(row, 'saved');
  assert.equal(row.invoice_number, 'ארנונה 09-10/28 · נכס 6532008800300');
  const html = await get(`/invoices/${row.id}`);
  assert.match(html, /מס׳ נכס<\/span><span class="mono">6532008800300/);
  assert.match(html, /מס׳ מסלקה<\/span><span class="mono">1013852007/);
  assert.match(html, /תקופה<\/span><span class="mono">09-10\/28/);
  assert.match(html, /חשבון ארנונה/);
  // the edit form opens on the bill row, with the months filled for the picker
  const edit = await get(`/invoices/${row.id}/edit`);
  assert.match(edit, /<div class="row" data-doc-std style="display:none">/);
  assert.match(edit, /name="period_from" data-dp-mode="month" required value="2028-09-01"/);
  assert.match(edit, /<option value="arnona" selected>חשבון ארנונה<\/option>/);
});

test('a check that pays a bill prints the bill line without an "invoice" prefix or date', async () => {
  const { invoice } = await createInvoice(bill({ propertyNumber: '999', periodFrom: '2029-01', periodTo: '2029-02' }), o, db);
  const ba = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id]);
  const pay = await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '90000123', paymentDate: '2029-01-10', invoiceIds: [invoice.id] }, o, db);
  const data = await getCheckPrintData(pay.id ?? pay.payment?.id, db);
  assert.equal(data.lines[0].text, 'ארנונה 01-02/29 · נכס 999');
});

test('migration: an existing SQLite DB gets the widened CHECK and the columns, rows and indexes intact', () => {
  // a pre-arnona schema: today's schema.sql minus the new value and columns
  const now = readFileSync(new URL('../src/db/schema.sql', import.meta.url), 'utf8');
  const old = now.replace(",'arnona'", '').replace(/^\s*(property_number|clearing_number|period_from|period_to)\s+TEXT,\n/gm, '')
    .replace(/^ *-- 🏛️ חשבון ארנונה.*\n.*\n/m, ''); // its comment (mentions 'arnona')
  assert.ok(!old.includes("'arnona'") && !/property_number/.test(old));
  const sq = new Database(':memory:');
  sq.exec(old);
  sq.exec("INSERT INTO companies (id, name) VALUES (1, 'ח')");
  sq.exec("INSERT INTO stores (id, company_id, name) VALUES (1, 1, 'ס')");
  sq.exec("INSERT INTO users (id, username, password_hash, role, name) VALUES (1, 'u', 'x', 'owner', 'u')");
  sq.exec("INSERT INTO suppliers (id, name, status) VALUES (1, 'ספ', 'approved')");
  sq.exec(`INSERT INTO invoices (id, supplier_id, company_id, store_id, invoice_number, allocation_number, invoice_date,
             amount_before_vat, vat_amount, total_amount, doc_type, created_by)
           VALUES (5, 1, 1, 1, 'A-1', '123456789', '2026-01-01', 100, 18, 118, 'tax_invoice', 1)`);
  assert.throws(() => sq.exec("UPDATE invoices SET doc_type = 'arnona' WHERE id = 5"), /CHECK/);
  migrate(sq);
  const cols = sq.prepare('PRAGMA table_info(invoices)').all().map((c) => c.name);
  for (const c of ['property_number', 'clearing_number', 'period_from', 'period_to', 'tracked_for_payment', 'notes']) assert.ok(cols.includes(c), c);
  const r = sq.prepare('SELECT * FROM invoices WHERE id = 5').get();
  assert.equal(r.invoice_number, 'A-1');
  assert.equal(r.total_amount, 118);
  sq.exec("UPDATE invoices SET doc_type = 'arnona' WHERE id = 5"); // now allowed
  const idx = sq.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'invoices'").all().map((i) => i.name);
  assert.ok(idx.includes('ux_invoices_allocation'), 'the unique allocation index is back');
  assert.deepEqual(sq.prepare('PRAGMA foreign_key_check').all(), []);
  migrate(sq); // idempotent
});
