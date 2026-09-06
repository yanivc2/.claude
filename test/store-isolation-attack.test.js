// Adversarial audit of the store boundary.
//
// The active-store picker ("החלף") is a CONVENIENCE filter — it must never be what keeps a user
// out of another store. The boundary is req.scope, and these tests attack it directly: a user
// granted exactly ONE store tries, over real HTTP, to read and to act on a second store's data —
// by URL id, by forged form fields, and by flipping the ap_store cookie.
//
// Every case here must fail closed. A leak in a GET is bad; a WRITE that lands in another store is
// worse, because it is money.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession, hashPassword } from '../src/lib/auth.js';
import { createInvoice } from '../src/services/invoices.js';
import { createZClosing } from '../src/services/zclosing.js';

let server, base, db;
let mine, theirs; // two stores, different companies
let attacker, ownerUser;
let cookie;

const form = (obj) => {
  const b = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) v.forEach((x) => b.append(k, String(x)));
    else b.append(k, String(v));
  }
  return b;
};

before(async () => {
  db = await freshDb();
  ownerUser = await db.one("SELECT * FROM users WHERE role = 'owner' LIMIT 1", []);

  const stores = await db.many(
    'SELECT s.*, c.name AS company_name FROM stores s JOIN companies c ON c.id = s.company_id ORDER BY s.id',
    [],
  );
  assert.ok(stores.length >= 2, 'the seed must have at least two stores');
  mine = stores[0];
  theirs = stores.find((s) => s.company_id !== mine.company_id) || stores[1];

  // The attacker is a manager granted EXACTLY ONE store, with broad action permissions — the point
  // is that permissions never substitute for scope.
  const perms = [
    'nav_dashboard', 'nav_invoices', 'nav_payments', 'nav_zreports', 'nav_suppliers',
    'nav_reconciliation', 'nav_zclosing', 'nav_outstanding', 'nav_profitability',
    'approve_payment', 'hold_invoice', 'edit_invoice', 'manage_deposits', 'import_bank',
  ].join(',');
  // role is 'secretary' (the only non-owner role in the schema); the elevated abilities come from
  // the permission list, which is exactly the situation being tested: permissions ≠ scope.
  await db.run(
    `INSERT INTO users (name, role, username, password_hash, permissions) VALUES (?, 'secretary', ?, ?, ?)`,
    ['תוקף', 'attacker', hashPassword('attacker1234'), perms],
  );
  attacker = await db.one("SELECT * FROM users WHERE username = 'attacker'", []);
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [attacker.id, mine.company_id]);
  await db.run('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)', [attacker.id, mine.id]);

  // One invoice in each store, so there is something real to reach for.
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='ספק'", []);
  // Distinct dates/amounts so the near-duplicate warning (R4) doesn't block the second one.
  let n = 0;
  for (const [tag, st] of [['MINE', mine], ['THEIRS', theirs]]) {
    n += 1;
    await createInvoice(
      { supplierId: sup.id, storeId: st.id, invoiceNumber: `INV-${tag}`, invoiceDate: `2026-0${n}-05`, amountBeforeVat: 10000 + n * 3333, vatAmount: 0, docType: 'tax_invoice' },
      ownerUser, db,
    );
  }

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `session=${createSession(attacker.id)}`;
});
after(() => server && server.close());

const get = (path, extraCookie = '') =>
  fetch(`${base}${path}`, { headers: { cookie: cookie + extraCookie }, redirect: 'manual' });
const post = (path, body, extraCookie = '') =>
  fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookie + extraCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

// --- the switch itself --------------------------------------------------------------------------

test('the store picker offers only the granted store, and never the other one', async () => {
  // Assert on the NAME, not on `value="<id>"` — the id collides with unrelated pickers on the
  // page (the company filter), and the name is the thing that must never appear.
  for (const path of ['/', '/invoices/new', '/zclosing', '/suppliers/new', '/reports/profitability']) {
    const res = await get(path);
    if (res.status >= 400) continue;
    const html = await res.text();
    assert.ok(!html.includes(theirs.name), `${path} named a store we were never granted`);
  }
});

test('POST /context/store with an unauthorized store id does not switch the context', async () => {
  const res = await post('/context/store', form({ store_id: theirs.id, return_to: '/' }));
  assert.ok(res.status === 303 || res.status === 204, `answered ${res.status}`);
  // The cookie is either absent or not set to the foreign store.
  const setCookie = res.headers.get('set-cookie') || '';
  assert.ok(!new RegExp(`ap_store=${theirs.id}\\b`).test(setCookie), 'no cookie for a store we cannot see');
});

test('forging the ap_store cookie to another store does not widen anything', async () => {
  // Even if the cookie is hand-crafted, the context resolves against the authorized set only.
  const html = await (await get('/invoices', `; ap_store=${theirs.id}`)).text();
  assert.match(html, /INV-MINE/);
  assert.ok(!/INV-THEIRS/.test(html), 'a forged cookie must not reveal the other store');
});

// --- reading by id ------------------------------------------------------------------------------

test('lists never contain the other store, with or without an active store', async () => {
  for (const extra of ['', `; ap_store=${mine.id}`]) {
    for (const path of ['/invoices', '/payments', '/reports/zreports', '/reports/outstanding', '/reconciliation']) {
      const res = await get(path, extra);
      if (res.status >= 400) continue; // page not granted — also fine
      const html = await res.text();
      assert.ok(!new RegExp(theirs.name).test(html), `${path} leaked the other store's name`);
      assert.ok(!/INV-THEIRS/.test(html), `${path} leaked the other store's invoice`);
    }
  }
});

test('opening the other store\'s invoice by id is refused', async () => {
  const theirInv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'INV-THEIRS'", []);
  const mineInv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'INV-MINE'", []);
  assert.equal((await get(`/invoices/${mineInv.id}`)).status, 200, 'our own invoice still opens');
  assert.equal((await get(`/invoices/${theirInv.id}`)).status, 404, 'theirs must 404, not 403 (no existence leak)');
});

test('the other store\'s bank account is not reachable through reconciliation', async () => {
  const theirAcct = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [theirs.id]);
  const res = await get(`/reconciliation?account=${theirAcct.id}`);
  if (res.status < 400) {
    const html = await res.text();
    assert.ok(!new RegExp(theirs.name).test(html), 'a forged ?account= must fall back to an authorized account');
  }
});

// --- writing ------------------------------------------------------------------------------------

test('creating an invoice for the other store is refused', async () => {
  const sup = await db.one("SELECT id FROM suppliers WHERE name='ספק'", []);
  const before = await db.one('SELECT COUNT(*) AS n FROM invoices WHERE store_id = ?', [theirs.id]);
  await post('/invoices', form({
    supplier_id: sup.id,
    store_id: theirs.id, // forged
    invoice_number: 'ATTACK-1',
    invoice_date: '2026-02-02',
    amount_before_vat: '100',
    vat_amount: '0',
    doc_type: 'tax_invoice',
  }));
  const after = await db.one('SELECT COUNT(*) AS n FROM invoices WHERE store_id = ?', [theirs.id]);
  assert.equal(Number(after.n), Number(before.n), 'no invoice may be created in a store we cannot access');
  const stray = await db.one("SELECT store_id FROM invoices WHERE invoice_number = 'ATTACK-1'", []);
  if (stray) assert.equal(Number(stray.store_id), mine.id, 'if anything was created it must be in OUR store');
});

test('recording a register closing for the other store is refused', async () => {
  const before = await db.one('SELECT COUNT(*) AS n FROM z_closings WHERE store_id = ?', [theirs.id]);
  await post('/zclosing', form({
    employee_first: 'א', employee_last: 'ב', z_number: 'ATK-1',
    drawer_cash: '100',
    store_id: theirs.id, // forged
  }));
  const after = await db.one('SELECT COUNT(*) AS n FROM z_closings WHERE store_id = ?', [theirs.id]);
  assert.equal(Number(after.n), Number(before.n), 'no register closing may land in another store');
});

test('acting on the other store\'s invoice (approve / hold / delete) is refused', async () => {
  const theirInv = await db.one("SELECT id, status FROM invoices WHERE invoice_number = 'INV-THEIRS'", []);
  for (const action of [`/invoices/${theirInv.id}/approve-payment`, `/invoices/${theirInv.id}/hold`, `/invoices/${theirInv.id}/delete`]) {
    const res = await post(action, form({ reason: 'x' }));
    assert.ok(res.status === 404 || res.status === 403, `${action} answered ${res.status}`);
  }
  const still = await db.one('SELECT id, status FROM invoices WHERE id = ?', [theirInv.id]);
  assert.ok(still, 'the invoice still exists');
  assert.equal(still.status, theirInv.status, 'its status is untouched');
});

test('a register closing of the other store cannot be read or deleted', async () => {
  const zId = await createZClosing(
    { employeeFirst: 'ז', employeeLast: 'ר', zNumber: 'THEIRS-Z', drawerCash: 10000, storeId: theirs.id, counts: {}, registers: [], expenses: [] },
    ownerUser, db,
  );
  assert.ok(zId, 'the fixture closing was created');
  const res = await get(`/zclosing/${zId}`);
  assert.ok(res.status === 404 || res.status === 403, `GET answered ${res.status}`);
  const del = await post(`/zclosing/${zId}/delete`, form({}));
  assert.ok(del.status === 404 || del.status === 403, `delete answered ${del.status}`);
  assert.ok(await db.one('SELECT id FROM z_closings WHERE id = ?', [zId]), 'it still exists');
});

// --- the reports surface ------------------------------------------------------------------------

test('report exports do not carry the other store', async () => {
  for (const path of ['/reports/outstanding.csv', '/reports/profitability', '/reports/lookup?q=INV']) {
    const res = await get(path);
    if (res.status >= 400) continue;
    const body = await res.text();
    assert.ok(!/INV-THEIRS/.test(body), `${path} leaked the other store's invoice`);
    assert.ok(!new RegExp(theirs.name).test(body), `${path} leaked the other store's name`);
  }
});

// --- the harder case: a SIBLING store inside the SAME company ----------------------------------
//
// Cross-company is caught by the company filter alone. The real test of per-store grants is a
// second store the user's own company owns: every company check passes, and only the store
// dimension stands between the user and it.

let sibling; // a second store of `mine`'s company

test('setup: a sibling store in the same company, with its own data', async () => {
  const r = await db.run('INSERT INTO stores (company_id, name) VALUES (?, ?)', [mine.company_id, 'סניף אחות']);
  sibling = { id: Number(r.lastInsertRowid), company_id: mine.company_id, name: 'סניף אחות' };
  await db.run(
    `INSERT INTO bank_accounts (company_id, store_id, bank_name, branch, account_number, display_name)
     VALUES (?, ?, 'הפועלים', '999', '9999999', ?)`,
    [mine.company_id, sibling.id, 'חשבון אחות'],
  );
  const sup = await db.one("SELECT id FROM suppliers WHERE name='ספק'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: sibling.id, invoiceNumber: 'INV-SIB', invoiceDate: '2026-05-05', amountBeforeVat: 77777, vatAmount: 0, docType: 'tax_invoice' },
    ownerUser, db,
  );
  assert.ok(sibling.id);
});

test('the sibling store is never named in any picker', async () => {
  for (const path of ['/', '/invoices/new', '/zclosing', '/suppliers/new', '/reports/zreports', '/reports/profitability']) {
    const res = await get(path);
    if (res.status >= 400) continue;
    const html = await res.text();
    assert.ok(!html.includes(sibling.name), `${path} offered a sibling store we were not granted`);
  }
});

test('the sibling store\'s invoice is invisible and unreachable', async () => {
  const sibInv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'INV-SIB'", []);
  assert.ok(!(await (await get('/invoices')).text()).includes('INV-SIB'), 'listed');
  assert.equal((await get(`/invoices/${sibInv.id}`)).status, 404, 'opened by id');
  const res = await post(`/invoices/${sibInv.id}/approve-payment`, form({}));
  assert.ok(res.status === 404 || res.status === 403, `approve answered ${res.status}`);
});

test('nothing can be WRITTEN into the sibling store', async () => {
  const sup = await db.one("SELECT id FROM suppliers WHERE name='ספק'", []);

  const invBefore = await db.one('SELECT COUNT(*) AS n FROM invoices WHERE store_id = ?', [sibling.id]);
  await post('/invoices', form({
    supplier_id: sup.id, store_id: sibling.id, invoice_number: 'ATK-SIB',
    invoice_date: '2026-06-06', amount_before_vat: '50', vat_amount: '0', doc_type: 'tax_invoice',
  }));
  const invAfter = await db.one('SELECT COUNT(*) AS n FROM invoices WHERE store_id = ?', [sibling.id]);
  assert.equal(Number(invAfter.n), Number(invBefore.n), 'an invoice landed in the sibling store');

  const zcBefore = await db.one('SELECT COUNT(*) AS n FROM z_closings WHERE store_id = ?', [sibling.id]);
  await post('/zclosing', form({
    employee_first: 'א', employee_last: 'ב', z_number: 'ATK-SIB-Z', drawer_cash: '100', store_id: sibling.id,
  }));
  const zcAfter = await db.one('SELECT COUNT(*) AS n FROM z_closings WHERE store_id = ?', [sibling.id]);
  assert.equal(Number(zcAfter.n), Number(zcBefore.n), 'a register closing landed in the sibling store');

  const zrBefore = await db.one('SELECT COUNT(*) AS n FROM z_reports WHERE store_id = ?', [sibling.id]);
  await post('/reports/zreports', form({
    store_id: sibling.id, z_number: 'ATK-SIB-ZR', z_date: '2026-06-06',
    daily_total: '100', drawer_cash: '100', drawer_check: '0', drawer_credit: '0',
  }));
  const zrAfter = await db.one('SELECT COUNT(*) AS n FROM z_reports WHERE store_id = ?', [sibling.id]);
  assert.equal(Number(zrAfter.n), Number(zrBefore.n), 'a Z report landed in the sibling store');
});

test('an invoice cannot be MOVED into a store outside the grants', async () => {
  const mineInv = await db.one("SELECT * FROM invoices WHERE invoice_number = 'INV-MINE'", []);
  await post(`/invoices/${mineInv.id}/edit`, form({
    supplier_id: mineInv.supplier_id,
    store_id: sibling.id, // forged move
    invoice_number: mineInv.invoice_number,
    invoice_date: mineInv.invoice_date,
    amount_before_vat: '100',
    vat_amount: '0',
    doc_type: mineInv.doc_type,
  }));
  const after = await db.one('SELECT store_id FROM invoices WHERE id = ?', [mineInv.id]);
  assert.equal(Number(after.store_id), Number(mine.id), 'the invoice was moved out of our store');
});

test('the sibling store\'s bank account cannot fund a payment', async () => {
  const sibAcct = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [sibling.id]);
  const before = await db.one('SELECT COUNT(*) AS n FROM payments WHERE bank_account_id = ?', [sibAcct.id]);
  const sup = await db.one("SELECT id FROM suppliers WHERE name='ספק'", []);
  await post('/payments', form({
    bank_account_id: sibAcct.id,
    advance_supplier_id: sup.id,
    advance_amount: '500',
    method: 'check',
    check_number: 'ATK-9',
    payment_date: '2026-06-06',
  }));
  const after = await db.one('SELECT COUNT(*) AS n FROM payments WHERE bank_account_id = ?', [sibAcct.id]);
  assert.equal(Number(after.n), Number(before.n), 'a payment was drawn on a store we cannot access');
});

// --- the switch's HTTP contract ------------------------------------------------------------------

test('the plain (no-JS) switch answers 303 See Other, never 302', async () => {
  // 302 on a POST lets the agent re-issue it as a POST to the target. On the installed PWA that
  // meant clicking "החלף" never navigated and the app looked frozen. 303 forces a GET.
  const res = await post('/context/store', form({ store_id: mine.id, return_to: '/invoices' }));
  assert.equal(res.status, 303, 'must be See Other');
  assert.equal(res.headers.get('location'), '/invoices');

  // Clearing the context takes the same path.
  const cleared = await post('/context/store', form({ store_id: '', return_to: '/' }));
  assert.equal(cleared.status, 303);

  // The fetch path (what the header actually uses) still answers 204 with no redirect at all.
  const viaFetch = await fetch(`${base}/context/store`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'x-requested-with': 'fetch' },
    body: form({ store_id: mine.id, return_to: '/invoices' }),
  });
  assert.equal(viaFetch.status, 204);
  assert.equal(viaFetch.headers.get('location'), null, 'no redirect for the fetch path');
});

test('the switch form routes its button through the fetch path, not a native POST', async () => {
  const html = await (await get('/')).text();
  const m = /<form[^>]*action="\/context\/store"[^>]*>/.exec(html);
  if (m) {
    assert.match(m[0], /onsubmit=/, 'the form must intercept its own submit');
    assert.match(m[0], /apAutoSubmit/, 'and go through apAutoSubmit like the select does');
  }
});
