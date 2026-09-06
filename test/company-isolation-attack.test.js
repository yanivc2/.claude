// Adversarial audit of the COMPANY boundary ("הפרדת חברות").
//
// Companion to store-isolation-attack.test.js, one level up: here the attacker is granted a whole
// company (every store in it, no per-store grant) and goes after a SECOND company's data — its
// stores, invoices, payments, bank accounts, Z reports, deposits, employees and audit trail.
//
// The distinction that matters: a company grant legitimately widens the store set, so nothing may
// rely on a per-store grant existing. Everything here must be stopped by the company dimension
// alone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession, hashPassword } from '../src/lib/auth.js';
import { createInvoice } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZReport } from '../src/services/zreports.js';

let server, base, db;
let myCompany, theirCompany, myStore, theirStore;
let attacker, ownerUser, supplier;
let cookie;

const form = (obj) => {
  const b = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) v.forEach((x) => b.append(k, String(x)));
    else b.append(k, String(v));
  }
  return b;
};
const get = (p) => fetch(`${base}${p}`, { headers: { cookie }, redirect: 'manual' });
const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

before(async () => {
  db = await freshDb();
  ownerUser = await db.one("SELECT * FROM users WHERE role = 'owner' LIMIT 1", []);

  const stores = await db.many('SELECT * FROM stores ORDER BY id', []);
  myStore = stores[0];
  theirStore = stores.find((s) => s.company_id !== myStore.company_id);
  assert.ok(theirStore, 'the seed must have two companies');
  myCompany = Number(myStore.company_id);
  theirCompany = Number(theirStore.company_id);

  // Granted the COMPANY, with no user_stores row — so the store set is "every store of my company".
  const perms = [
    'nav_dashboard', 'nav_invoices', 'nav_payments', 'nav_zreports', 'nav_suppliers',
    'nav_reconciliation', 'nav_zclosing', 'nav_outstanding', 'nav_profitability', 'nav_audit',
    'nav_employees', 'approve_payment', 'hold_invoice', 'edit_invoice', 'manage_deposits',
    'import_bank', 'manage_suppliers', 'void_payment',
  ].join(',');
  await db.run(
    "INSERT INTO users (name, role, username, password_hash, permissions) VALUES (?, 'secretary', ?, ?, ?)",
    ['תוקף חברה', 'coattacker', hashPassword('attacker1234'), perms],
  );
  attacker = await db.one("SELECT * FROM users WHERE username = 'coattacker'", []);
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [attacker.id, myCompany]);

  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק משותף', 'approved')", []);
  supplier = await db.one("SELECT * FROM suppliers WHERE name='ספק משותף'", []);

  // Real data on both sides.
  let n = 0;
  for (const [tag, st] of [['CO-MINE', myStore], ['CO-THEIRS', theirStore]]) {
    n += 1;
    await createInvoice(
      { supplierId: supplier.id, storeId: st.id, invoiceNumber: `INV-${tag}`, invoiceDate: `2026-0${n}-07`, amountBeforeVat: 20000 + n * 1111, vatAmount: 0, docType: 'tax_invoice' },
      ownerUser, db,
    );
  }
  // A payment and a Z report in the other company, to reach for.
  const theirAcct = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [theirStore.id]);
  const theirInv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'INV-CO-THEIRS'", []);
  await createPayment(
    { bankAccountId: theirAcct.id, method: 'check', checkNumber: 'CO-9001', paymentDate: '2026-02-10', invoiceIds: [theirInv.id] },
    ownerUser, db,
  );
  await createZReport(
    { storeId: theirStore.id, zNumber: 'CO-Z-THEIRS', zDate: '2026-02-11', dailyTotal: 50000, drawerCash: 50000, drawerCheck: 0, drawerCredit: 0 },
    ownerUser, db,
  );

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `session=${createSession(attacker.id)}`;
});
after(() => server && server.close());

// --- what the company grant legitimately gives ---------------------------------------------------

test('a company grant does give every store of that company', async () => {
  const html = await (await get('/invoices')).text();
  assert.match(html, /INV-CO-MINE/, 'our own company\'s data is visible');
});

// --- reading -------------------------------------------------------------------------------------

test('no page or export names the other company or its store', async () => {
  const theirCo = await db.one('SELECT name FROM companies WHERE id = ?', [theirCompany]);
  for (const path of [
    '/', '/invoices', '/payments', '/reconciliation', '/suppliers', '/suppliers/new',
    '/reports/zreports', '/reports/outstanding', '/reports/outstanding.csv',
    '/reports/profitability', '/reports/lookup?q=INV', '/zclosing', '/invoices/new', '/audit',
  ]) {
    const res = await get(path);
    if (res.status >= 400) continue;
    const body = await res.text();
    assert.ok(!body.includes('INV-CO-THEIRS'), `${path} leaked the other company's invoice`);
    assert.ok(!body.includes('CO-9001'), `${path} leaked the other company's check`);
    assert.ok(!body.includes('CO-Z-THEIRS'), `${path} leaked the other company's Z report`);
    assert.ok(!body.includes(theirStore.name), `${path} leaked the other company's store`);
    assert.ok(!body.includes(theirCo.name), `${path} leaked the other company's name`);
  }
});

test('every by-id entity of the other company answers 404', async () => {
  const inv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'INV-CO-THEIRS'", []);
  const pay = await db.one("SELECT id FROM payments WHERE check_number = 'CO-9001'", []);
  const zr = await db.one("SELECT id FROM z_reports WHERE z_number = 'CO-Z-THEIRS'", []);
  for (const path of [
    `/invoices/${inv.id}`,
    `/payments/${pay.id}`,
    `/payments/${pay.id}/print`,
    `/reports/zreports/${zr.id}`,
  ]) {
    const res = await get(path);
    assert.ok(res.status === 404 || res.status === 403, `${path} answered ${res.status}`);
  }
});

test('a forged ?company= / ?store= does not widen the dashboard', async () => {
  const html = await (await get(`/?company=${theirCompany}&store=${theirStore.id}`)).text();
  assert.ok(!html.includes(theirStore.name), 'a forged company/store filter leaked the other company');
});

test('a forged ?account= does not reach the other company\'s bank account', async () => {
  const theirAcct = await db.one('SELECT id, display_name FROM bank_accounts WHERE store_id = ?', [theirStore.id]);
  for (const path of [`/reconciliation?account=${theirAcct.id}`, `/payments?company=${theirCompany}`]) {
    const res = await get(path);
    if (res.status >= 400) continue;
    const html = await res.text();
    assert.ok(!html.includes(theirAcct.display_name), `${path} leaked the other company's account`);
  }
});

// --- writing -------------------------------------------------------------------------------------

test('nothing can be written into the other company', async () => {
  const invBefore = await db.one('SELECT COUNT(*) AS n FROM invoices WHERE store_id = ?', [theirStore.id]);
  await post('/invoices', form({
    supplier_id: supplier.id, store_id: theirStore.id, invoice_number: 'CO-ATK',
    invoice_date: '2026-06-06', amount_before_vat: '50', vat_amount: '0', doc_type: 'tax_invoice',
  }));
  const invAfter = await db.one('SELECT COUNT(*) AS n FROM invoices WHERE store_id = ?', [theirStore.id]);
  assert.equal(Number(invAfter.n), Number(invBefore.n), 'an invoice landed in the other company');

  const zrBefore = await db.one('SELECT COUNT(*) AS n FROM z_reports WHERE store_id = ?', [theirStore.id]);
  await post('/reports/zreports', form({
    store_id: theirStore.id, z_number: 'CO-ATK-Z', z_date: '2026-06-06',
    daily_total: '100', drawer_cash: '100', drawer_check: '0', drawer_credit: '0',
  }));
  const zrAfter = await db.one('SELECT COUNT(*) AS n FROM z_reports WHERE store_id = ?', [theirStore.id]);
  assert.equal(Number(zrAfter.n), Number(zrBefore.n), 'a Z report landed in the other company');

  const zcBefore = await db.one('SELECT COUNT(*) AS n FROM z_closings WHERE store_id = ?', [theirStore.id]);
  await post('/zclosing', form({
    employee_first: 'א', employee_last: 'ב', z_number: 'CO-ATK-ZC', drawer_cash: '100', store_id: theirStore.id,
  }));
  const zcAfter = await db.one('SELECT COUNT(*) AS n FROM z_closings WHERE store_id = ?', [theirStore.id]);
  assert.equal(Number(zcAfter.n), Number(zcBefore.n), 'a register closing landed in the other company');
});

test('the other company\'s payment cannot be voided, cleared or edited', async () => {
  const pay = await db.one("SELECT id, status FROM payments WHERE check_number = 'CO-9001'", []);
  for (const path of [`/payments/${pay.id}/void`, `/payments/${pay.id}/clear`, `/payments/${pay.id}/edit`]) {
    const res = await post(path, form({ reason: 'x' }));
    assert.ok(res.status === 404 || res.status === 403, `${path} answered ${res.status}`);
  }
  const after = await db.one('SELECT status FROM payments WHERE id = ?', [pay.id]);
  assert.equal(after.status, pay.status, 'the payment status changed');
});

test('a payment cannot be drawn on the other company\'s bank account', async () => {
  const theirAcct = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [theirStore.id]);
  const before = await db.one('SELECT COUNT(*) AS n FROM payments WHERE bank_account_id = ?', [theirAcct.id]);
  await post('/payments', form({
    bank_account_id: theirAcct.id, advance_supplier_id: supplier.id, advance_amount: '500',
    method: 'check', check_number: 'CO-ATK-9', payment_date: '2026-06-06',
  }));
  const after = await db.one('SELECT COUNT(*) AS n FROM payments WHERE bank_account_id = ?', [theirAcct.id]);
  assert.equal(Number(after.n), Number(before.n), 'a payment was drawn on the other company');
});

test('the other company\'s bank transactions cannot be imported into or edited', async () => {
  const theirAcct = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [theirStore.id]);
  const before = await db.one('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?', [theirAcct.id]);
  await post('/reconciliation/add', form({
    account_id: theirAcct.id, txn_date: '2026-06-06', amount: '-100', description: 'atk', reference: 'x',
  }));
  const after = await db.one('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?', [theirAcct.id]);
  assert.equal(Number(after.n), Number(before.n), 'a transaction landed in the other company\'s account');
});

// --- settings / org management -------------------------------------------------------------------

test('org and user management stay owner-only', async () => {
  for (const path of ['/settings', '/settings/companies', '/settings/users']) {
    const res = await get(path);
    assert.ok(res.status >= 400 || res.status === 302, `${path} answered ${res.status}`);
  }
  // Creating a store inside the other company, or a company outright, must be refused.
  const before = await db.one('SELECT COUNT(*) AS n FROM stores WHERE company_id = ?', [theirCompany]);
  await post('/settings/stores', form({ company_id: theirCompany, store_name: 'סניף פיראטי' }));
  const after = await db.one('SELECT COUNT(*) AS n FROM stores WHERE company_id = ?', [theirCompany]);
  assert.equal(Number(after.n), Number(before.n), 'a store was created in the other company');
});

test('the audit log does not expose the other company\'s actions', async () => {
  const res = await get('/audit');
  if (res.status < 400) {
    const html = await res.text();
    assert.ok(!html.includes('CO-9001'), 'the audit log leaked the other company\'s check');
  }
});
