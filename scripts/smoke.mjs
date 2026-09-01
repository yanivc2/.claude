// Boot the real Express app against a fresh in-memory SQLite DB (schema + seed), sign an owner
// session, and GET every page — asserting each renders healthily (right status, not the error
// page). Catches EJS/template regressions and 500s that unit tests miss.
//
// Usage:
//   node scripts/smoke.mjs             → full sweep of all GET routes (seeds data for :id pages)
//   node scripts/smoke.mjs /a /b …     → quick check of just those paths (expects 200)
import Database from 'better-sqlite3';
import { initDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setScanEnabled } from '../src/services/appSettings.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZReport, replaceExpenses } from '../src/services/zreports.js';
import { createZClosing } from '../src/services/zclosing.js';
import { createEmployee } from '../src/services/employees.js';
import { createDraft } from '../src/services/scan.js';
import { putBuffer } from '../src/lib/storage.js';
import { config } from '../src/config.js';
import { unlink } from 'node:fs/promises';
import path from 'node:path';

const sqliteDb = new Database(':memory:');
const x = await initDb({ sqliteDb });
await seed(x);
const owner = await x.one("SELECT * FROM users WHERE role = 'owner' LIMIT 1", []);
const cookie = 'session=' + encodeURIComponent(createSession(owner.id));

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const errored = (body) => body.includes('<title>שגיאה') || body.includes('Cannot GET') || body.includes('Cannot POST');

// ── quick mode: explicit paths, expect 200 ──────────────────────────────────────
const args = process.argv.slice(2);
if (args.length) {
  let bad = 0;
  for (const p of args) {
    try {
      const res = await fetch(base + p, { headers: { cookie }, redirect: 'manual' });
      const body = res.status < 400 ? await res.text() : '';
      const ok = (res.status === 200 || res.status === 303) && !errored(body);
      console.log(`${ok ? 'ok ' : 'FAIL'} ${res.status} ${p}`);
      if (!ok) { bad++; if (body) console.log('   ' + body.replace(/\s+/g, ' ').slice(0, 300)); }
    } catch (e) { bad++; console.log(`FAIL --- ${p}  ${e.message}`); }
  }
  server.close();
  console.log(bad ? `\n${bad} FAILED` : '\nall pages rendered');
  process.exit(bad ? 1 : 0);
}

// ── full mode: seed data so :id pages have real targets, then sweep every GET route ──
await setScanEnabled(true, x);
const store = await x.one('SELECT id FROM stores LIMIT 1', []);
const ba = await x.one('SELECT id FROM bank_accounts WHERE store_id = ? LIMIT 1', [store.id]);
await x.run("INSERT INTO suppliers (name, status) VALUES ('ספק סמוק', 'approved')", []);
const sup = await x.one("SELECT * FROM suppliers WHERE name = 'ספק סמוק'", []);
await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'SMK-1', invoiceDate: '2026-08-05', amountBeforeVat: 100000, vatAmount: 17000, docType: 'tax_invoice' }, owner, x);
const inv = await x.one("SELECT id FROM invoices WHERE invoice_number = 'SMK-1'", []);
await approveInvoiceForPayment(inv.id, owner, x);
const pay = await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '9001', paymentDate: '2026-08-10', invoiceIds: [inv.id] }, owner, x);
// a second, UNPAID invoice — editing a paid one legitimately redirects, so the edit page needs this one
await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'SMK-2', invoiceDate: '2026-08-06', amountBeforeVat: 20000, vatAmount: 3400, docType: 'tax_invoice' }, owner, x);
const inv2 = await x.one("SELECT id FROM invoices WHERE invoice_number = 'SMK-2'", []);
// a real (tiny) image so the scan draft's image route resolves instead of 500-ing on a missing file
const imgRef = await putBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), '.jpg', 'image/jpeg');
const zr = await createZReport({ storeId: store.id, zNumber: '800', zDate: '2026-08-15', dailyTotal: 500000, drawerCash: 500000 }, owner, x);
await replaceExpenses(zr.id, [{ kind: 'manual', payerName: 'טרה', purpose: 'ירקות', amount: 5000 }], owner, x);
const zexp = await x.one('SELECT id FROM z_expenses WHERE z_report_id = ? LIMIT 1', [zr.id]);
await createZClosing({ employeeFirst: 'א', employeeLast: 'ב', zNumber: '850', drawerCash: 20000, storeId: store.id, counts: {}, registers: [], expenses: [] }, owner, x);
const closing = await x.one('SELECT id FROM z_closings ORDER BY id DESC LIMIT 1', []);
await createEmployee({ firstName: 'סמוק', lastName: 'עובד', phone: '050-0000000' }, owner, x);
await x.run("INSERT INTO products (supplier_id, name, barcode) VALUES (?, 'מוצר סמוק', '1234567890123')", [sup.id]);
const prod = await x.one("SELECT id FROM products WHERE name = 'מוצר סמוק'", []);
const draft = await createDraft({ storeId: store.id, imageRefs: [imgRef], supplierId: sup.id }, owner, x);

// category → predicate over {status, body}
const P = {
  page: (s, b) => s === 200 && !errored(b),
  redirectOk: (s, b) => [200, 302, 303].includes(s) && !errored(b),
  csv: (s) => s === 200,
  json: (s) => s === 200,
  asset: (s) => [200, 302, 304, 404].includes(s), // images/backup: file or friendly miss, never 5xx
  soft: (s, b) => s < 500 && !errored(b),          // token pages: legit invalid-token errors excluded elsewhere
  softAny: (s) => s < 500,                          // token pages: an invalid-token error page is acceptable
};

const routes = [
  // public + account (login/forgot/reset/invite hit WITHOUT auth — an authenticated user is redirected)
  ['page', '/login', true], ['page', '/forgot', true], ['page', '/privacy'], ['page', '/accessibility'],
  ['softAny', '/reset/DUMMYTOKEN', true], ['softAny', '/invite/DUMMYTOKEN', true],
  ['page', '/account/password'],
  // dashboard + approvals + audit + notifications
  ['page', '/'], ['page', '/approvals'], ['page', '/audit'], ['page', '/notifications'],
  // invoices
  ['page', '/invoices'], ['page', '/invoices/new'],
  ['page', `/invoices/${inv.id}`], ['page', `/invoices/${inv2.id}/edit`],
  ['asset', `/invoices/${inv.id}/image`], ['asset', `/invoices/${inv.id}/scan-image/0`],
  // payments
  ['page', '/payments'], ['page', '/payments/new'],
  ['page', `/payments/${pay.id}`], ['page', `/payments/${pay.id}/edit`], ['page', `/payments/${pay.id}/print`],
  // reports
  ['page', '/reports/zreports'], ['page', `/reports/zreports/${zr.id}`], ['asset', `/reports/zreports/${zr.id}/image`],
  ['asset', `/reports/zexpenses/${zexp.id}/image`],
  ['page', '/reports/outstanding'], ['csv', '/reports/outstanding.csv'], ['csv', `/reports/outstanding-detail.csv?account=${ba.id}`],
  ['page', '/reports/lookup'], ['csv', '/reports/lookup.csv?q=SMK'],
  ['page', '/reports/profitability'], ['csv', '/reports/profitability.csv'],
  // reconciliation
  ['page', '/reconciliation'],
  // zclosing
  ['page', '/zclosing'], ['page', `/zclosing/${closing.id}`],
  // suppliers
  ['page', '/suppliers'], ['page', '/suppliers/contacts'], ['page', '/suppliers/new'], ['page', `/suppliers/${sup.id}/edit`],
  // employees
  ['page', '/employees'],
  // settings
  ['page', '/settings'], ['page', '/settings/guide'], ['asset', '/settings/backup'],
  // products (hidden from nav, mounted)
  ['page', '/products'], ['page', `/products/${prod.id}`], ['page', '/products/master'], ['json', '/products/master/export.json'],
  // scan (enabled above)
  ['page', '/scan'], ['page', '/scan/pending'], ['redirectOk', `/scan/${draft.id}`],
  ['json', `/scan/${draft.id}/status.json`], ['asset', `/scan/${draft.id}/image/0`],
];

let bad = 0;
for (const [cat, path, noauth] of routes) {
  try {
    const res = await fetch(base + path, { headers: noauth ? {} : { cookie }, redirect: 'manual' });
    const body = res.status < 400 ? await res.text() : '';
    const ok = P[cat](res.status, body);
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(res.status).padEnd(3)} [${cat}] ${path}`);
    if (!ok) { bad++; if (body) console.log('     ' + body.replace(/\s+/g, ' ').slice(0, 240)); }
  } catch (e) { bad++; console.log(`FAIL ---  ${path}  ${e.message}`); }
}

server.close();
await unlink(path.join(config.uploadsDir, imgRef)).catch(() => {}); // tidy the seeded smoke image
console.log(`\n${routes.length} GET routes checked · ${bad ? bad + ' FAILED' : 'all healthy'}`);
process.exit(bad ? 1 : 0);
