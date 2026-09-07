// A GET to an action URL must land on a page, never on the error screen.
//
// THE BUG: several POST handlers answered by rendering the list page instead of redirecting to it.
// The action worked, but the browser was left parked on a URL that only accepts POST — and the next
// reload, back/forward or PWA restore issued a GET to e.g. /employees/54/stores and got
// "הדף המבוקש לא נמצא", with the save already applied. This suite pins both halves of the fix:
// the actions redirect (so the browser never parks there), and any stray GET to a POST-only route
// still lands somewhere sane — including for routes that do not exist yet, since the fallback
// derives its list from the router itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createEmployee } from '../src/services/employees.js';
import { setScanEnabled } from '../src/services/appSettings.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZReport, replaceExpenses } from '../src/services/zreports.js';
import { createZClosing } from '../src/services/zclosing.js';
import { collectRoutes } from '../src/middleware/actionUrlFallback.js';

let db, server, base, cookie, empId;

before(async () => {
  db = await freshDb();
  await setScanEnabled(true, db); // otherwise /scan/* answers 423 (locked) before the fallback runs
  const ow = await owner(db);
  empId = (await createEmployee({ firstName: 'רות', lastName: 'לוי', phone: '050-3334445' }, ow, db)).id;

  // The sweep below substitutes id 1 into every :id. Seed one real row per entity so the by-id
  // guards (router.use('/zreports/:id', scopeParam(…)) and friends) resolve — otherwise the sweep
  // measures "no such record", which is a different 404 and not the bug under test.
  const store = await db.one('SELECT * FROM stores ORDER BY id LIMIT 1', []);
  const acct = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [store.id]);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name = 'ספק'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'AF-1', invoiceDate: '2026-05-01',
      amountBeforeVat: 10000, vatAmount: 1800, docType: 'tax_invoice' }, ow, db,
  );
  const invRow = await db.one("SELECT id FROM invoices WHERE invoice_number = 'AF-1'", []);
  await approveInvoiceForPayment(invRow.id, ow, db);
  await createPayment(
    { bankAccountId: acct.id, method: 'check', checkNumber: '4001', paymentDate: '2026-05-02', invoiceIds: [invRow.id] },
    ow, db,
  );
  const zr = await createZReport(
    { storeId: store.id, zNumber: '600', zDate: '2026-05-03', dailyTotal: 100000, drawerCash: 100000 }, ow, db,
  );
  await replaceExpenses(zr.id, [{ kind: 'manual', payerName: 'א', purpose: 'ב', amount: 1000 }], ow, db);
  await createZClosing(
    { employeeFirst: 'רות', employeeLast: 'לוי', zNumber: '601', drawerCash: 5000, storeId: store.id,
      counts: {}, registers: [], expenses: [] }, ow, db,
  );
  await db.run(
    'INSERT INTO deposits (store_id, deposit_date, amount, created_by) VALUES (?, ?, ?, ?)',
    [store.id, '2026-05-04', 50000, ow.id],
  );
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `session=${encodeURIComponent(createSession(ow.id))}`;
});
after(() => server && server.close());

const get = (path) => fetch(base + path, { headers: { cookie }, redirect: 'manual' });

test('THE CASE: a stray GET to /employees/:id/stores lands on the employees page', async () => {
  const res = await get(`/employees/${empId}/stores`);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/employees');
});

test('saving an employee’s stores REDIRECTS — the browser never parks on the action URL', async () => {
  const res = await fetch(`${base}/employees/${empId}/stores`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'store_ids=1',
    redirect: 'manual',
  });
  assert.equal(res.status, 303);
  const to = res.headers.get('location');
  assert.match(to, /^\/employees\?saved=/);
  // …and the page it lands on renders, carrying the confirmation through the redirect.
  const page = await get(to);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('שיוך החנויות עודכן'));
});

test('every POST-only route answers a GET with a redirect, not the error page', async () => {
  const app = createApp();
  const routes = collectRoutes(app);
  const norm = (p) => p.replace(/\/$/, '') || '/';
  const getPaths = new Set(routes.get.map(norm));
  const postOnly = routes.post
    .map(norm)
    .filter((p) => !getPaths.has(p))
    .filter((p) => !p.startsWith('/ingest')); // machine endpoints stay 404 on purpose

  // A literal action path (/invoices/pay-batch) is shadowed by a param GET (/invoices/:id) — the
  // sweep must still find it redirecting, which is why the middleware runs before the routers.
  assert.ok(postOnly.includes('/invoices/pay-batch'), 'the shadowed-literal case is in the sweep');

  assert.ok(postOnly.length > 40, `expected the real action-route table, got ${postOnly.length}`);
  const bad = [];
  for (const p of postOnly) {
    const path = p.replace(/:[^/]+/g, String(empId));
    const res = await get(path);
    if (res.status !== 303) bad.push(`${path} → ${res.status}`);
  }
  assert.deepEqual(bad, [], `these action URLs still dead-end on a GET:\n${bad.join('\n')}`);
});

test('the fallback does not swallow anything it should not', async () => {
  // A machine endpoint stays a 404 rather than being redirected to a page.
  assert.equal((await get('/ingest/bank-txns')).status, 404);
  // A genuinely unknown path stays a 404.
  assert.equal((await get('/employees/nope/nope')).status, 404);
  // A real page is untouched.
  assert.equal((await get('/employees')).status, 200);
});
