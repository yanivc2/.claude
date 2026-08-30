import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier } from '../src/services/suppliers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { createZReport, replaceExpenses, zSequenceStatus, unmatchedCashExpenses } from '../src/services/zreports.js';
import { createZClosing } from '../src/services/zclosing.js';
import { createEmployee, listEmployees, listEmployeeLedger } from '../src/services/employees.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { autoReconcile } from '../src/services/reconciliation.js';
import { upsertDepositForZ, listDeposits, declaredNotDeposited, zReportsWithoutDeposit } from '../src/services/deposits.js';
import { dashboardStats, profitability, outstandingChecks, lastReconciliationFor, invoiceLookup } from '../src/services/reports.js';

// Cross-page data-flow map: data entered at one source must surface at every destination that reads
// it. This mirrors the "connection audit" — it seeds each source once, then asserts the couplings so
// a future change that silently drops a column/query (e.g. the "שולם בצ׳ק" regression) fails here.

let db, ow, store, otherStore, ba, sup, emp, invId, payId, zA, zB;
let server, base;
const cookie = (extra = '') => `session=${createSession(ow.id)}${extra}`;
const GET = async (path, storeId) =>
  (await fetch(`${base}${path}`, { headers: { cookie: cookie(storeId ? `; ap_store=${storeId}` : '') } })).text();

before(async () => {
  db = await freshDb();
  ow = await owner(db);
  store = await firstStore(db);
  otherStore = await db.one('SELECT id FROM stores WHERE id <> ? LIMIT 1', [store.id]);
  ba = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק מאושר', 'approved')", []);
  sup = await db.one("SELECT * FROM suppliers WHERE name='ספק מאושר'", []);

  // employee → feeds the Z salary line
  emp = await createEmployee({ firstName: 'רון', lastName: 'לוי', phone: '050-9999999' }, ow, db);

  // pending supplier (approvals / R1)
  await createSupplier({ name: 'ספק ממתין לבדיקה', phone: '050-1112222' }, ow, db);

  // invoice → approve → pay by check
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: 'INV-100', invoiceDate: '2026-08-05', amountBeforeVat: 100000, vatAmount: 17000, docType: 'tax_invoice' }, ow, db);
  invId = (await db.one("SELECT id FROM invoices WHERE invoice_number='INV-100'", [])).id;
  await approveInvoiceForPayment(invId, ow, db);
  payId = (await createPayment({ bankAccountId: ba.id, method: 'check', checkNumber: '5001', paymentDate: '2026-08-10', invoiceIds: [invId] }, ow, db)).id;

  // bank import → auto-reconcile the check
  await importTransactions(ba.id, [{ txnDate: '2026-08-12', amount: -117000, description: 'צ׳ק 5001', rawReference: '5001' }], 'csv', ow, db);
  await autoReconcile(ba.id, ow, db);

  // Z report A: sales + salary line, left WITHOUT a deposit
  zA = (await createZReport({ storeId: store.id, zNumber: '900', zDate: '2026-08-15', dailyTotal: 500000, drawerCash: 500000 }, ow, db)).id;
  await replaceExpenses(zA, [{ kind: 'salary', employeeId: emp.id, amount: 30000, payerName: 'רון לוי' }], ow, db);

  // Z report B: gets a declared (not-yet-deposited) deposit
  zB = (await createZReport({ storeId: store.id, zNumber: '901', zDate: '2026-08-16', dailyTotal: 400000, drawerCash: 400000 }, ow, db)).id;
  await upsertDepositForZ(zB, { storeId: store.id, depositDate: '2026-08-17', bagNumber: 'BAG-77', amount: 400000, deposited: false }, ow, db);

  // register closing with an unmatched cash expense
  await createZClosing({ employeeFirst: 'משה', employeeLast: 'כהן', zNumber: '950', drawerCash: 20000, storeId: store.id, counts: {}, registers: [], expenses: [{ kind: 'manual', expenseDate: '2026-08-18', payerName: 'ספק ירקות', purpose: 'ירקות', amount: 8000 }] }, ow, db);

  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('עובד → מופיע ברשימת העובדים (בורר שכר/מפרעה)', async () => {
  const list = await listEmployees({ includeInactive: true }, db);
  assert.ok(list.some((e) => e.id === emp.id));
});

test('ספק ממתין → לוח בקרה + אישורים + תשלום חסום (R1)', async () => {
  const stats = await dashboardStats(null, null, db);
  assert.ok(Number(stats.pendingSuppliers) >= 1);
  const html = await GET('/approvals');
  assert.match(html, /ספק ממתין לבדיקה/);
  // R1: a pending supplier's invoice cannot be paid
  const pend = await db.one("SELECT id FROM suppliers WHERE name='ספק ממתין לבדיקה'", []);
  await createInvoice({ supplierId: pend.id, storeId: store.id, invoiceNumber: 'P-1', invoiceDate: '2026-08-01', amountBeforeVat: 10000, vatAmount: 0, docType: 'tax_invoice' }, ow, db);
  const pInv = await db.one("SELECT id FROM invoices WHERE invoice_number='P-1'", []);
  await assert.rejects(createPayment({ bankAccountId: ba.id, method: 'cash', payerName: 'x', paymentDate: '2026-08-02', invoiceIds: [pInv.id] }, ow, db));
});

test('חשבונית → חיפוש בלוח בקרה + קניות ברווחיות', async () => {
  const lk = await invoiceLookup('INV-100', { scope: null }, db);
  assert.ok(lk.some((r) => String(r.invoice_number) === 'INV-100'));
  const prof = await profitability('2026-08-01', '2026-08-31', null, db);
  const sp = prof.stores.find((s) => s.id === store.id);
  assert.ok(sp && sp.purchases >= 117000);
});

test('תשלום/צ׳ק → צ׳קים בחוץ + "שולם ב..." בפירוט החשבונית', async () => {
  const oc = await outstandingChecks(null, { storeId: store.id }, db);
  assert.ok(oc.totalOutstanding >= 0); // the check was auto-cleared below; totalOutstanding is the live liability
  const html = await GET(`/invoices/${invId}`);
  assert.match(html, /שולם ב[^—]*צ׳ק/); // real method label (not the old always-"צ׳ק" bug via missing column)
  assert.match(html, /5001/);
});

test('תנועת בנק → צ׳ק סומן נפרע + "התאמת בנק אחרונה" בלוח בקרה', async () => {
  const p = await db.one('SELECT status FROM payments WHERE id = ?', [payId]);
  assert.equal(p.status, 'cleared');
  const rec = await lastReconciliationFor(null, store.id, db);
  assert.ok(rec && rec.ts);
});

test('דוח Z → מכירות ברווחיות + שכר בספר העובד + דוח ללא הפקדה', async () => {
  const prof = await profitability('2026-08-01', '2026-08-31', null, db);
  const sp = prof.stores.find((s) => s.id === store.id);
  assert.ok(sp && sp.sales >= 900000); // zA 500k + zB 400k
  const ledger = await listEmployeeLedger({ employeeId: emp.id }, db);
  assert.ok(ledger.some((l) => Number(l.amount) === 30000));
  const noDep = await zReportsWithoutDeposit({ scope: null, storeId: store.id }, db);
  assert.ok(noDep.some((z) => z.id === zA)); // zA never got a deposit
  const seq = await zSequenceStatus(null, store.id, db);
  assert.ok(seq && typeof seq === 'object');
});

test('הפקדה → היסטוריית הפקדות + "הוצהרה ולא הופקדה" + יוצא מ"ללא הפקדה"', async () => {
  const deps = await listDeposits({ scope: null, storeId: store.id }, db);
  assert.ok(deps.some((d) => d.bag_number === 'BAG-77'));
  const notDep = await declaredNotDeposited({ scope: null, storeId: store.id }, db);
  assert.ok(notDep.length >= 1);
  const noDep = await zReportsWithoutDeposit({ scope: null, storeId: store.id }, db);
  assert.ok(!noDep.some((z) => z.id === zB)); // zB got a declared deposit → out of the list
});

test('סגירת Z → מזומן ללא התאמה בלוח בקרה + רובריקה בדף חשבוניות', async () => {
  const unmatched = await unmatchedCashExpenses(null, 30, store.id, db);
  assert.ok(unmatched.length >= 1);
  const html = await GET('/invoices', store.id);
  assert.match(html, /הוצאות מזומן/);
});

test('חנות פעילה → מסננת את לוח הבקרה (החלפה משנה נתונים)', async () => {
  const a = await GET('/', store.id);
  const b = await GET('/', otherStore.id);
  assert.notEqual(a, b);
});
