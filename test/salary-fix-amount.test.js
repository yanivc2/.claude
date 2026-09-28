// 🏦 "עדכן לסכום בבנק" — הסכום שהוזן שגוי באגורות (נצפה: 2,383.60 מול 2,383.66). הסכום נלקח
// מהחיוב עצמו, והשורה משויכת אליו; רק לאותה אסמכתה, חיוב פנוי, אותה חברה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createEmployee } from '../src/services/employees.js';
import { createSalaryPayment, fixSalaryAmountToBank, attachSalaryBankHints, listSalaryPayments } from '../src/services/salaryPayments.js';
import { importTransactions } from '../src/services/bankTransactions.js';

let server, base;
before(async () => { server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server && server.close());

async function world() {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const acct = (await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id])).id;
  const emp = await createEmployee({ firstName: 'מירסלבה', lastName: 'אמבלובה' }, o, db);
  return { db, o, st, acct, emp };
}

test('הכפתור מוצע, הסכום מתעדכן מהבנק, והשורה נפרעת — הסכום הקודם ביומן', async () => {
  const { db, o, st, acct, emp } = await world();
  await importTransactions(acct, [{ txnDate: '2026-09-11', amount: -238366, description: 'שיק', rawReference: '32000', externalId: 'x1' }], 'scraper', o, db);
  const sp = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: '32000', dueDate: '2026-09-09', amount: 238360 }, o, db);
  const row = (await attachSalaryBankHints(await listSalaryPayments({}, db), db)).find((r) => r.id === sp.id);
  assert.equal(row.bank_fix.amount, 238366);
  const fixed = await fixSalaryAmountToBank(sp.id, row.bank_fix.txnId, o, db);
  assert.equal(fixed.amount, 238366);
  assert.equal(Number(fixed.bank_txn_id), row.bank_fix.txnId);
  const log = await db.one("SELECT details FROM audit_log WHERE action = 'salary.amount_from_bank' AND entity_id = ?", [sp.id]);
  assert.match(String(log.details), /238360/);
  await assert.rejects(() => fixSalaryAmountToBank(sp.id, row.bank_fix.txnId, o, db), /כבר הותאם/);
});

test('אסמכתה אחרת / מקבץ — אין תיקון', async () => {
  const { db, o, st, acct, emp } = await world();
  await importTransactions(acct, [{ txnDate: '2026-09-11', amount: -100001, description: 'שיק', rawReference: '11111', externalId: 'y1' }], 'scraper', o, db);
  const txn = await db.one("SELECT id FROM bank_transactions WHERE external_id = 'y1'", []);
  const other = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: '22222', dueDate: '2026-09-09', amount: 100000 }, o, db);
  await assert.rejects(() => fixSalaryAmountToBank(other.id, txn.id, o, db), /האסמכתה בבנק שונה/);
  const batch = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'batch', reference: '11111', dueDate: '2026-09-09', amount: 100000 }, o, db);
  await assert.rejects(() => fixSalaryAmountToBank(batch.id, txn.id, o, db), /בודדת בלבד/);
  const rows = await attachSalaryBankHints(await listSalaryPayments({}, db), db);
  assert.equal(rows.find((r) => r.id === batch.id).bank_fix, undefined, 'למקבץ לא מוצע כפתור');
});

test('דרך הדף: 303 והודעה; ושורת שכר ממזהה מזויף מחוץ לסקופ — 404', async () => {
  const { db, o, st, acct, emp } = await world();
  await importTransactions(acct, [{ txnDate: '2026-09-11', amount: -555556, description: 'שיק', rawReference: '40000', externalId: 'z1' }], 'scraper', o, db);
  const txn = await db.one("SELECT id FROM bank_transactions WHERE external_id = 'z1'", []);
  const sp = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: '40000', dueDate: '2026-09-09', amount: 555550 }, o, db);
  const cookie = `session=${createSession(o.id)}`;
  const r = await fetch(`${base}/employees/salary/${sp.id}/fix-amount`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ txn_id: String(txn.id) }).toString(),
  });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/employees?saved=amountfixed');
  assert.equal((await db.one('SELECT amount FROM salary_payments WHERE id = ?', [sp.id])).amount, 555556);

  // משתמש שמוגבל לחנות אחרת (אותן הרשאות, סקופ אחר) לא נוגע בשורת השכר הזו — גם לא ב"מחק" /
  // "נפרט" / "בטל התאמה", שעד עכשיו קיבלו כל מזהה.
  const { hashPassword } = await import('../src/lib/auth.js');
  const otherStore = await db.one('SELECT id, company_id FROM stores WHERE company_id <> ? ORDER BY id LIMIT 1', [st.company_id]);
  await db.run(`INSERT INTO users (name, role, username, password_hash, permissions) VALUES ('מוגבל', 'secretary', 'narrow1', ?, 'nav_employees')`, [hashPassword('narrow12345')]);
  const u = await db.one("SELECT id FROM users WHERE username = 'narrow1'", []);
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [u.id, otherStore.company_id]);
  await db.run('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)', [u.id, otherStore.id]);
  const ucookie = `session=${createSession(u.id)}`;
  for (const action of ['delete', 'uncashed', 'fix-amount']) {
    const res = await fetch(`${base}/employees/salary/${sp.id}/${action}`, {
      method: 'POST', redirect: 'manual', headers: { cookie: ucookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ txn_id: String(txn.id) }).toString(),
    });
    assert.equal(res.status, 404, `${action} מחוץ לסקופ`);
  }
  assert.ok(await db.one('SELECT id FROM salary_payments WHERE id = ?', [sp.id]), 'השורה עדיין קיימת');
});
