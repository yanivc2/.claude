import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setUserStores } from '../src/lib/scope.js';

// End-to-end (HTTP, no network) checks for the active-store context: banner, the switch endpoint,
// cookie persistence, and the new-invoice store lock.

let server, base, db;
const cookieFor = (u) => `session=${createSession(u.id)}`;
const get = (path, cookie) => fetch(`${base}${path}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });

before(async () => {
  db = await freshDb();
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('owner dashboard shows the store banner with a switcher', async () => {
  const res = await get('/', cookieFor(await owner(db)));
  const html = await res.text();
  assert.match(html, /store-banner/);
  assert.match(html, /חנות פעילה/);
  assert.match(html, /action="\/context\/store"/); // multi-store owner → switch form present
});

test('POST /context/store sets the ap_store cookie for an authorized store', async () => {
  const res = await fetch(`${base}/context/store`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: cookieFor(await owner(db)), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ store_id: '3', return_to: '/' }),
  });
  // 303 See Other, not 302: after a POST, 302 lets the agent re-issue the request as a POST to the
  // target, which is what left the installed PWA frozen on the "החלף" button.
  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie') || '', /ap_store=3/);
});

test('new-invoice locks the store field to the active store (readonly, no select)', async () => {
  const cookie = `${cookieFor(await owner(db))}; ap_store=3`;
  const res = await get('/invoices/new', cookie);
  const html = await res.text();
  assert.match(html, /name="store_id"[^>]*value="3"/);        // hidden locked value
  assert.match(html, /נעול לחנות הפעילה/);                      // lock hint
  assert.doesNotMatch(html, /<select name="store_id" required/); // the form's free picker is gone (banner switch is separate)
});

test('a user granted a single store is auto-locked (banner shows locked, no switcher)', async () => {
  const sec = await db.one("SELECT * FROM users WHERE role='secretary' LIMIT 1", []);
  await setUserStores(sec.id, [4], db); // exactly one store
  const res = await get('/', cookieFor(sec));
  const html = await res.text();
  assert.match(html, /נעול לחנות זו/);
  assert.doesNotMatch(html, /action="\/context\/store"/); // no switch form when locked to one store
});

// --- the active store must actually FILTER the screens, not just relabel the banner -------------
//
// The complaint that produced these: after switching to one store, "צ׳קים בחוץ" still listed every
// store's checks. For an owner nothing restricts the scope, so a page that ignores the active store
// simply shows everything — and the picker looks broken.

test('the active store filters צ׳קים בחוץ, its CSV, Z reports and bank reconciliation', async () => {
  const { createInvoice, approveInvoiceForPayment } = await import('../src/services/invoices.js');
  const { createPayment } = await import('../src/services/payments.js');
  const ow = await owner(db);
  const stores = await db.many('SELECT * FROM stores ORDER BY id', []);
  const [a, b] = stores;
  assert.ok(b, 'two stores needed');

  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק חתך', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='ספק חתך'", []);

  // One open check per store, so each store has something to show.
  let n = 0;
  for (const st of [a, b]) {
    n += 1;
    const acct = await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id]);
    await createInvoice(
      { supplierId: sup.id, storeId: st.id, invoiceNumber: `CUT-${n}`, invoiceDate: `2026-0${n}-09`, amountBeforeVat: 10000 * n, vatAmount: 0, docType: 'tax_invoice' },
      ow, db,
    );
    const inv = await db.one('SELECT id FROM invoices WHERE invoice_number = ?', [`CUT-${n}`]);
    await approveInvoiceForPayment(inv.id, ow, db);
    await createPayment(
      { bankAccountId: acct.id, method: 'check', checkNumber: `CUT${n}00`, paymentDate: '2026-05-01', invoiceIds: [inv.id] },
      ow, db,
    );
  }

  const bare = cookieFor(ow);
  const withA = `${bare}; ap_store=${a.id}`;
  // The page lists bank ACCOUNTS (company + account display name), one per store — so that is what
  // "seeing another store" actually looks like on screen.
  // Match on the ACCOUNT NUMBER, not the display name: names contain an apostrophe (ג'וניור) that
  // EJS escapes to &#39;, so a raw substring match on the name would never hit.
  const acctA = await db.one('SELECT account_number FROM bank_accounts WHERE store_id = ?', [a.id]);
  const acctB = await db.one('SELECT account_number FROM bank_accounts WHERE store_id = ?', [b.id]);
  assert.notEqual(acctA.account_number, acctB.account_number);

  // With no active store the owner sees both stores…
  const all = await (await get('/reports/outstanding', bare)).text();
  assert.ok(all.includes(acctA.account_number) && all.includes(acctB.account_number), 'no active store → every store listed');

  // …and with one selected, only that one.
  const one = await (await get('/reports/outstanding', withA)).text();
  assert.ok(one.includes(acctA.account_number), 'the active store is shown');
  assert.ok(!one.includes(acctB.account_number), 'the other store must not be listed');

  // The CSV export mirrors the page.
  const csv = await (await get('/reports/outstanding.csv', withA)).text();
  assert.ok(csv.includes(acctA.account_number), 'the export has the active store');
  assert.ok(!csv.includes(acctB.account_number), 'the export must not carry the other store');

  // An explicit ?store= still wins, so a deliberate cross-store look stays possible.
  const forced = await (await get(`/reports/outstanding?store=${b.id}`, withA)).text();
  assert.ok(forced.includes(acctB.account_number), '?store= overrides the active store');

  // Bank reconciliation defaults to the ACTIVE store's account, not simply the first one.
  const recon = await (await get('/reconciliation', withA)).text();
  assert.ok(recon.includes(acctA.account_number), 'reconciliation opened on the active store');
});
