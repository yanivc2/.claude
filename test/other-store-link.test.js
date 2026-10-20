// בעלים 20/10: "נמצא בחנות אחרת — עבור אליה" — בקישור לרשומה. החנות הפעילה מצמצמת את מה שנראה, ולכן קישור
// לרשומה של חנות אחרת היה נגמר ב"לא נמצא". עכשיו — אם החנות הזו בין החנויות של המשתמש — דף שאומר לאיזו חנות
// הרשומה שייכת וכפתור שעובר אליה וחוזר לאותו קישור. למי שאין לו את החנות — "לא נמצא" כמו קודם, בלי שם החנות.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setUserStores } from '../src/lib/scope.js';
import { createInvoice } from '../src/services/invoices.js';
import { createZReport } from '../src/services/zreports.js';

let db, o, server, base, inv, zr, name4;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק קישור', 'approved')", []);
  const sup = await db.one("SELECT id FROM suppliers WHERE name = 'ספק קישור'", []);
  await createInvoice({ supplierId: sup.id, storeId: 4, invoiceNumber: 'OS-1', invoiceDate: '2026-10-01', amountBeforeVat: 10000, vatAmount: 1800, docType: 'tax_invoice' }, o, db);
  inv = await db.one("SELECT id FROM invoices WHERE invoice_number = 'OS-1'", []);
  zr = await createZReport({ storeId: 4, zNumber: '8801', zDate: '2026-10-01', dailyTotal: 10000, drawerCash: 10000 }, o, db);
  name4 = (await db.one('SELECT name FROM stores WHERE id = 4', [])).name;
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const get = (path, user, store) => fetch(`${base}${path}`, { redirect: 'manual', headers: { cookie: `session=${createSession(user.id)}; ap_store=${store}` } });

test('a link to a record of another of my stores offers to switch there — and comes back to the same link', async () => {
  for (const path of [`/invoices/${inv.id}`, `/reports/zreports/${zr.id}`]) {
    const res = await get(path, o, 3);
    assert.equal(res.status, 404, `${path}: still not shown inside store 3`);
    const html = await res.text();
    assert.match(html, new RegExp(`הרשומה שייכת לחנות <strong>${name4.replace(/"/g, '&#34;')}</strong>`), path);
    assert.match(html, /<form method="post" action="\/context\/store"/);
    assert.match(html, /<input type="hidden" name="store_id" value="4">/);
    assert.ok(html.includes(`<input type="hidden" name="return_to" value="${path}">`), `${path}: returns to the same link`);
  }
  const sw = await fetch(`${base}/context/store`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ store_id: '4', return_to: `/invoices/${inv.id}` }),
    headers: { cookie: `session=${createSession(o.id)}; ap_store=3`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(sw.status, 303);
  assert.equal(sw.headers.get('location'), `/invoices/${inv.id}`);
  assert.match(sw.headers.get('set-cookie') || '', /ap_store=4/);
  assert.equal((await get(`/invoices/${inv.id}`, o, 4)).status, 200, 'in store 4 the record opens');
});

test('a user without that store gets the plain "not found" — the store name is not revealed', async () => {
  const sec = await db.one("SELECT * FROM users WHERE role='secretary' LIMIT 1", []);
  await setUserStores(sec.id, [3], db);
  await db.run(`UPDATE users SET permissions = '["nav_invoices"]' WHERE id = ?`, [sec.id]);
  const res = await get(`/invoices/${inv.id}`, sec, 3);
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.doesNotMatch(html, /הרשומה שייכת לחנות/);
  assert.ok(!html.includes(name4), 'the other store is not named anywhere on the page');
  assert.doesNotMatch(html, /name="store_id" value="4"/, 'and no switch offer into it');
  assert.match(html, /הרשומה לא נמצאה/);
});
