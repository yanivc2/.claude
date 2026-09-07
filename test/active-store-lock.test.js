// 🔒 נעילה הרמטית — the active store is a rule for EVERY page and EVERY view, present and future.
//
// This suite is deliberately not a list of pages. It walks the Express router stack, collects
// every registered GET route, and sweeps them all with one branch selected — so a page added
// tomorrow is covered the moment it is mounted, with no test edit. If a new screen forgets to go
// through `req.scope`, this test is what tells us, before the owner finds it on their phone.
//
// The lock itself lives in ONE place: middleware/currentUser.js narrows `req.scope` to the active
// store (and its company). Everything downstream — scopeWhere/scopeClause in the list services,
// scopedStoreList in the pickers, filterByStoreLinks for suppliers/employees, assertInScope and
// assertStoreAllowed for by-id reads and writes — inherits it for free.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setScanEnabled } from '../src/services/appSettings.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZReport } from '../src/services/zreports.js';
import { createZClosing } from '../src/services/zclosing.js';
import { createEmployee, setEmployeeStores } from '../src/services/employees.js';
import { setSupplierStores } from '../src/services/suppliers.js';

// ── enumerate every GET route the app actually mounts ───────────────────────────────────────────
// Express keeps the mount prefix as a regexp on the layer; this reverses it well enough for the
// literal prefixes this app uses ('/invoices', '/reports', …).
function mountPrefix(layer) {
  if (!layer.regexp || layer.regexp.fast_slash) return '';
  return layer.regexp.source
    .replace('^\\/', '/')
    .replace('\\/?(?=\\/|$)', '')
    .replace(/\\\//g, '/')
    .replace(/\$$/, '')
    .replace(/\(\?=.*$/, '');
}

export function getRoutes(app, stack = app._router.stack, prefix = '') {
  const out = [];
  for (const layer of stack) {
    if (layer.route) {
      if (layer.route.methods.get) out.push(prefix + layer.route.path);
    } else if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...getRoutes(app, layer.handle.stack, prefix + mountPrefix(layer)));
    }
  }
  return out;
}

// Pages that legitimately show the whole org chart, and are not branch views at all:
//   • /settings*   — org administration: it is where the branches are CREATED, so of course it
//                    lists every company and store. It is owner-only (requireOwner).
//   • /notifications — the owner's alert stream: an alert is about whatever happened, anywhere.
//   • the public/auth pages — no scope exists yet.
const EXEMPT = [
  /^\/settings/,
  /^\/notifications/,
  /^\/(login|forgot|privacy|accessibility)$/,
  /^\/(reset|invite)\//,
];

let db, server, base, cookie, active, others, markers, ids;

before(async () => {
  db = await freshDb();
  await setScanEnabled(true, db);
  const ow = await owner(db);
  const stores = await db.many('SELECT * FROM stores ORDER BY id', []);
  active = stores[0]; // ג'וניור — the store in the screenshot's banner
  others = stores.slice(1); // …including מידנייט, the store the picker was showing
  assert.ok(others.length >= 2, 'the sweep needs several other branches to prove separation');

  // Give every store its own supplier, employee, invoice, check, Z report and register closing,
  // each tagged with a marker string that can only come from THAT store's data.
  ids = { invoice: {}, payment: {}, zreport: {}, closing: {} };
  for (const st of stores) {
    const tag = `LOCK${st.id}`;
    await db.run('INSERT INTO suppliers (name, status) VALUES (?, \'approved\')', [`ספק${tag}`]);
    const sup = await db.one('SELECT * FROM suppliers WHERE name = ?', [`ספק${tag}`]);
    await setSupplierStores(sup.id, [st.id], db);

    const emp = await createEmployee({ firstName: `עובד${tag}`, lastName: 'ל', phone: `050-000${1000 + st.id}` }, ow, db);
    await setEmployeeStores(emp.id, [st.id], ow, db);

    await createInvoice(
      { supplierId: sup.id, storeId: st.id, invoiceNumber: `${tag}-INV`, invoiceDate: `2026-0${st.id}-04`, amountBeforeVat: 1000 * st.id, vatAmount: 0, docType: 'tax_invoice' },
      ow, db,
    );
    const inv = await db.one('SELECT id FROM invoices WHERE invoice_number = ?', [`${tag}-INV`]);
    await approveInvoiceForPayment(inv.id, ow, db);
    const acct = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id]);
    const pay = await createPayment(
      { bankAccountId: acct.id, method: 'check', checkNumber: `${9100 + st.id}`, paymentDate: '2026-06-01', invoiceIds: [inv.id] },
      ow, db,
    );
    const z = await createZReport(
      { storeId: st.id, zNumber: `${7100 + st.id}`, zDate: `2026-06-0${st.id}`, dailyTotal: 100000, drawerCash: 100000 },
      ow, db,
    );
    await createZClosing(
      { employeeFirst: `עובד${tag}`, employeeLast: 'ל', zNumber: `${7200 + st.id}`, drawerCash: 5000, storeId: st.id, counts: {}, registers: [], expenses: [] },
      ow, db,
    );
    const closing = await db.one('SELECT id FROM z_closings ORDER BY id DESC LIMIT 1', []);
    ids.invoice[st.id] = inv.id;
    ids.payment[st.id] = pay.id;
    ids.zreport[st.id] = z.id;
    ids.closing[st.id] = closing.id;
  }

  // What "another branch showed up" looks like in raw HTML/CSV. Account numbers and invoice
  // numbers are ASCII, so unlike store names (ג'וניור → ג&#39;וניור) they match verbatim.
  markers = [];
  for (const st of others) {
    const acct = await db.one('SELECT account_number FROM bank_accounts WHERE store_id = ?', [st.id]);
    markers.push(
      { store: st.name, what: 'מספר חשבון בנק', s: acct.account_number },
      { store: st.name, what: 'מספר חשבונית', s: `LOCK${st.id}-INV` },
      { store: st.name, what: 'שם ספק', s: `ספקLOCK${st.id}` },
      { store: st.name, what: 'שם עובד', s: `עובדLOCK${st.id}` },
    );
  }

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `session=${encodeURIComponent(createSession(ow.id))}; ap_store=${active.id}`;
});

after(() => server && server.close());

// Fill :params with the ACTIVE store's own rows — a page must be clean even when it is legitimately
// showing this branch's detail.
function fill(path) {
  const a = active.id;
  return path
    .replace('/invoices/:id', `/invoices/${ids.invoice[a]}`)
    .replace('/payments/:id', `/payments/${ids.payment[a]}`)
    .replace('/reports/zreports/:id', `/reports/zreports/${ids.zreport[a]}`)
    .replace('/zclosing/:id', `/zclosing/${ids.closing[a]}`)
    .replace(/:idx/g, '0')
    .replace(/:token/g, 'DUMMY')
    .replace(/:id/g, '1');
}

test('every mounted GET route is swept — the list is derived from the app, not hand-written', () => {
  const routes = getRoutes(createApp());
  assert.ok(routes.length >= 45, `expected the full route table, got ${routes.length}`);
  assert.ok(routes.includes('/reports/outstanding'), 'sanity: a known page is in the derived list');
  assert.ok(routes.includes('/reconciliation/'), 'sanity: the page from the bug report is in the list');
});

test('🔒 with a branch selected, NO page or view leaks another branch — every GET route', async () => {
  const routes = getRoutes(createApp()).filter((p) => !EXEMPT.some((re) => re.test(p)));
  const leaks = [];
  let swept = 0;

  for (const route of routes) {
    const path = fill(route);
    const res = await fetch(base + path, { headers: { cookie }, redirect: 'manual' });
    if (res.status >= 500) { leaks.push(`${path} → ${res.status}`); continue; }
    const ct = res.headers.get('content-type') || '';
    if (!/text|json|csv/.test(ct)) continue; // images/binaries carry no store names
    const body = await res.text();
    swept += 1;
    for (const m of markers) {
      if (body.includes(m.s)) leaks.push(`${path} ← ${m.what} של ${m.store} (${m.s})`);
    }
  }

  assert.ok(swept >= 35, `too few pages actually rendered (${swept}) — the sweep proved nothing`);
  assert.deepEqual(leaks, [], `דליפה בין סניפים:\n${leaks.join('\n')}`);
});

test('🔒 the same sweep with ?store= / ?account= forced to another branch changes nothing', async () => {
  const other = others[0];
  const otherAcct = await db.one('SELECT id, account_number FROM bank_accounts WHERE store_id = ?', [other.id]);
  const forced = [
    `/reports/outstanding?store=${other.id}`,
    `/reports/outstanding.csv?store=${other.id}`,
    `/reports/zreports?zstore=${other.id}`,
    `/reconciliation/?account=${otherAcct.id}`,
    `/invoices/?store=${other.id}`,
    `/payments/?store=${other.id}`,
    `/?store=${other.id}`,
  ];
  for (const path of forced) {
    const res = await fetch(base + path, { headers: { cookie }, redirect: 'manual' });
    assert.ok(res.status < 500, `${path} → ${res.status}`);
    const body = await res.text();
    assert.ok(
      !body.includes(otherAcct.account_number) && !body.includes(`LOCK${other.id}-INV`),
      `${path} honoured a forced cross-branch parameter`,
    );
  }
});

test('🔒 a by-id page for another branch is refused (404), not merely filtered out of a list', async () => {
  const other = others[0];
  for (const path of [
    `/invoices/${ids.invoice[other.id]}`,
    `/payments/${ids.payment[other.id]}`,
    `/reports/zreports/${ids.zreport[other.id]}`,
  ]) {
    const res = await fetch(base + path, { headers: { cookie }, redirect: 'manual' });
    assert.equal(res.status, 404, `${path} should not be reachable from another branch`);
  }
});

test('clearing the active store restores the cross-branch view (כל החנויות)', async () => {
  const ow = await owner(db);
  const bare = `session=${encodeURIComponent(createSession(ow.id))}`;
  const body = await (await fetch(`${base}/reports/outstanding`, { headers: { cookie: bare } })).text();
  const seen = markers.filter((m) => m.what === 'מספר חשבון בנק' && body.includes(m.s));
  assert.ok(seen.length >= 2, 'with no active store the owner sees every branch again');
});

test('assigning a supplier/employee to another branch still works while locked (the one exception)', async () => {
  const other = others[0];
  const res = await fetch(`${base}/employees/`, { headers: { cookie } });
  const html = await res.text();
  // The store checkboxes for "העתק לחנות" come from the UNNARROWED grants, so a supplier or an
  // employee can still be copied to a sibling branch without switching context first. This shows
  // a store NAME the user is already granted — never another branch's data.
  assert.ok(html.includes(`value="${other.id}"`), 'the copy-to-branch picker still offers other branches');
});
