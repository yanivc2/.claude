import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import {
  isPettyExpense, invoiceMatchCandidates, salaryMatchCandidates,
  matchCashExpenseToInvoice, unmatchedCashExpenses, assertCashExpenseInScope, EXPENSE_KINDS,
} from '../src/services/zreports.js';
import { markCashed, alertOnSalaryChecksClearedBeforeMatch } from '../src/services/salaryPayments.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { listNotifications } from '../src/services/notifications.js';

async function anApproved(x, store, ow, num, agorot) {
  await x.run("INSERT INTO suppliers (name, status) VALUES ('טרה','approved')", []).catch(() => {});
  const sup = await x.one("SELECT * FROM suppliers WHERE name='טרה'", []);
  await createInvoice({ supplierId: sup.id, storeId: store.id, invoiceNumber: num, invoiceDate: '2026-09-01',
    amountBeforeVat: agorot, vatAmount: 0, docType: 'tax_invoice' }, ow, x);
  const inv = await x.one('SELECT * FROM invoices WHERE invoice_number = ?', [num]);
  await approveInvoiceForPayment(inv.id, ow, x);
  return inv;
}
async function aClosingExpense(x, store, ow, { kind = 'manual', purpose = 'ציוד', amount = 9000, empId = null } = {}) {
  const zc = await x.run(`INSERT INTO z_closings (employee_first,employee_last,store_id,z_number,drawer_cash,created_by)
                          VALUES ('רון','לוי',?,'2179',0,?)`, [store.id, ow.id]);
  const e = await x.run(`INSERT INTO z_closing_expenses (closing_id,expense_date,payer_name,purpose,description_type,employee_id,amount)
                         VALUES (?, '2026-09-10','נופר',?,?,?,?)`, [zc.lastInsertRowid, purpose, kind, empId, amount]);
  return Number(e.lastInsertRowid);
}

test('פריטה מזוהה גם כסוג וגם לפי הטקסט הישן', () => {
  assert.ok(EXPENSE_KINDS.has('petty'), 'petty הוא סוג קביל');
  assert.equal(isPettyExpense({ description_type: 'petty', purpose: '' }), true);
  assert.equal(isPettyExpense({ description_type: 'manual', purpose: 'פריטה' }), true, 'שורות ישנות לא דורשות הזנה מחדש');
  assert.equal(isPettyExpense({ description_type: 'manual', purpose: 'ציוד משרדי' }), false);
  assert.equal(isPettyExpense(null), false);
});

test('בורר החשבוניות מתחיל באותו סכום', async () => {
  const x = await freshDb();
  const ow = await owner(x);
  const store = await firstStore(x);
  await anApproved(x, store, ow, 'A1', 10000);
  await anApproved(x, store, ow, 'A2', 60900);
  const c = await invoiceMatchCandidates(60900, null, null, 10, x);
  assert.equal(c[0].invoice_number, 'A2');
  assert.equal(c[0].sameAmount, true);
  assert.ok(c.some((r) => r.invoice_number === 'A1'), 'סכום אחר עדיין זמין — תשלום חלקי קורה');
});

test('התאמה לחשבונית עובדת משני המקורות ומורידה מהרשימה', async () => {
  for (const source of ['zclosing', 'zreport']) {
    const x = await freshDb();
    const ow = await owner(x);
    const store = await firstStore(x);
    const inv = await anApproved(x, store, ow, 'B1', 9000);
    let id;
    if (source === 'zclosing') id = await aClosingExpense(x, store, ow);
    else {
      const zr = await x.run(`INSERT INTO z_reports (store_id,z_number,z_date,daily_total,drawer_cash,created_by)
                              VALUES (?,'900','2026-09-10',0,0,?)`, [store.id, ow.id]);
      const e = await x.run(`INSERT INTO z_expenses (z_report_id,expense_date,payer_name,purpose,description_type,amount)
                             VALUES (?, '2026-09-10','נופר','ציוד','manual',9000)`, [zr.lastInsertRowid]);
      id = Number(e.lastInsertRowid);
    }
    assert.ok((await unmatchedCashExpenses(null, 20, null, x)).some((r) => r.source === source));
    await matchCashExpenseToInvoice(source, id, inv.id, ow, null, x);
    assert.ok(!(await unmatchedCashExpenses(null, 20, null, x)).some((r) => r.source === source),
      `${source}: אחרי השיוך השורה יורדת`);
    // 🔴 ההתאמה מתריעה — זה מה שהבעלים ביקש לדעת עליו בזמן אמת
    const notes = await listNotifications({ limit: 10 }, x);
    assert.ok(notes.some((n) => n.kind === 'cash_match'), `${source}: נרשמה התראה`);
  }
});

test('התאמת שכר: הצ׳ק מבוטל, השורה יורדת, ונרשמת התראה', async () => {
  const x = await freshDb();
  const ow = await owner(x);
  const store = await firstStore(x);
  const acc = await accountForStore(x, store.id);
  const emp = await x.run("INSERT INTO employees (first_name,last_name) VALUES ('אורית','כהן')", []);
  const pay = await x.run(`INSERT INTO payments (bank_account_id,method,check_number,amount,payment_date,status,created_by)
                           VALUES (?, 'check','7001',500000,'2026-09-10','issued',?)`, [acc.id, ow.id]);
  const sp = await x.run(`INSERT INTO salary_payments (store_id,employee_id,method,due_date,amount,payment_id,created_by)
                          VALUES (?,?, 'check','2026-09-10',500000,?,?)`,
                         [store.id, emp.lastInsertRowid, pay.lastInsertRowid, ow.id]);
  const expId = await aClosingExpense(x, store, ow, { kind: 'salary', purpose: 'שכר', amount: 500000, empId: emp.lastInsertRowid });

  const cands = await salaryMatchCandidates(500000, null, null, 10, x);
  assert.equal(cands[0].sameAmount, true, 'אותו סכום ראשון');

  await markCashed(Number(sp.lastInsertRowid), expId, ow, x);
  const check = await x.one('SELECT status FROM payments WHERE id = ?', [pay.lastInsertRowid]);
  assert.equal(check.status, 'voided', 'הצ׳ק בוטל, אחרת ייפרע בבנק וישולם אותו שכר פעמיים');
  assert.ok(!(await unmatchedCashExpenses(null, 20, null, x)).some((r) => Number(r.id) === expId));
  const note = (await listNotifications({ limit: 10 }, x)).find((n) => n.kind === 'cash_match');
  assert.ok(note);
  // ההתראה אומרת מי — "עובד" גנרי אינו אינפורמציה, וזו בדיוק הסיבה ששולחים אותה
  assert.match(`${note.title} ${note.body || ''}`, /אורית כהן/);
});

test('🔴 צ׳ק שכר שנפרע לפני התאמה — התראה שאומרת זאת במפורש, פעם אחת', async () => {
  const x = await freshDb();
  const ow = await owner(x);
  const store = await firstStore(x);
  const acc = await accountForStore(x, store.id);
  const emp = await x.run("INSERT INTO employees (first_name,last_name) VALUES ('אורית','כהן')", []);
  const pay = await x.run(`INSERT INTO payments (bank_account_id,method,check_number,amount,payment_date,status,cleared_date,created_by)
                           VALUES (?, 'check','7002',500000,'2026-09-01','cleared','2026-09-08',?)`, [acc.id, ow.id]);
  await x.run(`INSERT INTO salary_payments (store_id,employee_id,method,due_date,amount,payment_id,created_by)
               VALUES (?,?, 'check','2026-09-01',500000,?,?)`, [store.id, emp.lastInsertRowid, pay.lastInsertRowid, ow.id]);

  assert.equal(await alertOnSalaryChecksClearedBeforeMatch(x), 1);
  const notes = await listNotifications({ limit: 10 }, x);
  const alert = notes.find((n) => n.kind === 'salary_cleared_unmatched');
  assert.ok(alert, 'נרשמה התראה');
  assert.match(`${alert.title} ${alert.body || ''}`, /לפני שנעשתה התאמה|לפני התאמה/, 'ההתראה אומרת שזה קרה לפני ההתאמה');

  // אידמפוטנטי — לא מציפים את הבעלים באותה התראה בכל סבב
  assert.equal(await alertOnSalaryChecksClearedBeforeMatch(x), 0);
});

test('🔴 מזהה מבקשה לא נוגע בשורה של חנות אחרת', async () => {
  const x = await freshDb();
  const ow = await owner(x);
  const stores = await x.many('SELECT * FROM stores ORDER BY id', []);
  if (stores.length < 2) return;
  const id = await aClosingExpense(x, { id: stores[1].id }, ow);
  await assert.rejects(
    () => assertCashExpenseInScope('zclosing', id, { companyIds: null, storeIds: [stores[0].id] }, x), /לא נמצאה/);
  await assert.rejects(
    () => matchCashExpenseToInvoice('zclosing', id, 1, ow, { companyIds: null, storeIds: [stores[0].id] }, x), /לא נמצאה/);
});

test('הלוח מציג כפתור לפי סוג ואת כרטיס ההתראות', () => {
  const v = readFileSync(new URL('../src/views/dashboard.ejs', import.meta.url), 'utf8');
  assert.match(v, /e\.petty/, 'פריטה מקבלת מסלול משלה');
  assert.match(v, /match-invoice/);
  assert.match(v, /match-salary/);
  assert.match(v, /התראות מזומן/);
  assert.match(v, /card no-collapse/, 'כרטיס אזהרה לא נסגר מאחורי אקורדיון');
  for (const f of ['zclosing/index', 'zclosing/edit', 'reports/_zform']) {
    const t = readFileSync(new URL(`../src/views/${f}.ejs`, import.meta.url), 'utf8');
    assert.match(t, /\['petty','פריטה'\]/, `${f}: סוג פריטה קיים בבורר`);
  }
});
