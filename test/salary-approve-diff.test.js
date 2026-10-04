// ✅ "אשר התאמה עם הפרש" — הצ׳ק נכתב בסכום שונה במעט (נצפה: 2,383.66 בבנק מול 2,383.60 בשכר) וההפרש
// אושר. הסכום שהוזן **נשאר**, השורה משויכת לחיוב, וההערה חובה. רק אותה אסמכתה, חיוב פנוי, אותה חברה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createEmployee } from '../src/services/employees.js';
import { createSalaryPayment, approveSalaryBankDiff, attachSalaryBankHints, listSalaryPayments } from '../src/services/salaryPayments.js';
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

test('אישור עם הפרש: הסכום שהוזן נשאר, השורה נפרעת, ההערה וההפרש מוצגים; בלי הערה — לא', async () => {
  const { db, o, st, acct, emp } = await world();
  await importTransactions(acct, [{ txnDate: '2026-09-11', amount: -238366, description: 'שיק', rawReference: '32000', externalId: 'x1' }], 'scraper', o, db);
  const sp = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: '32000', dueDate: '2026-09-09', amount: 238360 }, o, db);
  const row = (await attachSalaryBankHints(await listSalaryPayments({}, db), db)).find((r) => r.id === sp.id);
  assert.equal(row.bank_diff.amount, 238366);
  assert.equal(row.bank_diff.diff, 6);
  await assert.rejects(() => approveSalaryBankDiff(sp.id, row.bank_diff.txnId, '   ', o, db), /צריך לכתוב הערה/);
  const ok = await approveSalaryBankDiff(sp.id, row.bank_diff.txnId, 'הצ׳ק נכתב 2,383.66 בטעות — ההפרש אושר', o, db);
  assert.equal(ok.amount, 238360, 'הסכום שהוזן נשאר');
  assert.equal(Number(ok.bank_txn_id), row.bank_diff.txnId);
  const listed = (await listSalaryPayments({}, db)).find((r) => r.id === sp.id);
  assert.equal(listed.bank_note, 'הצ׳ק נכתב 2,383.66 בטעות — ההפרש אושר');
  assert.equal(listed.bank_diff_amount, 6);
  const log = await db.one("SELECT details FROM audit_log WHERE action = 'salary.bank_diff_approved' AND entity_id = ?", [sp.id]);
  assert.match(String(log.details), /"diff":6/);
  await assert.rejects(() => approveSalaryBankDiff(sp.id, row.bank_diff.txnId, 'שוב', o, db), /כבר הותאם/);
});

test('אסמכתה אחרת / מקבץ — אין אישור', async () => {
  const { db, o, st, acct, emp } = await world();
  await importTransactions(acct, [{ txnDate: '2026-09-11', amount: -100001, description: 'שיק', rawReference: '11111', externalId: 'y1' }], 'scraper', o, db);
  const txn = await db.one("SELECT id FROM bank_transactions WHERE external_id = 'y1'", []);
  const other = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: '22222', dueDate: '2026-09-09', amount: 100000 }, o, db);
  await assert.rejects(() => approveSalaryBankDiff(other.id, txn.id, 'הערה', o, db), /האסמכתה בבנק שונה/);
  const batch = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'batch', reference: '11111', dueDate: '2026-09-09', amount: 100000 }, o, db);
  await assert.rejects(() => approveSalaryBankDiff(batch.id, txn.id, 'הערה', o, db), /בודדת בלבד/);
  const rows = await attachSalaryBankHints(await listSalaryPayments({}, db), db);
  assert.equal(rows.find((r) => r.id === batch.id).bank_diff, undefined, 'למקבץ לא מוצע כפתור');
});

test('דרך הדף: 303 והודעה; ושורת שכר ממזהה מזויף מחוץ לסקופ — 404', async () => {
  const { db, o, st, acct, emp } = await world();
  await importTransactions(acct, [{ txnDate: '2026-09-11', amount: -555556, description: 'שיק', rawReference: '40000', externalId: 'z1' }], 'scraper', o, db);
  const txn = await db.one("SELECT id FROM bank_transactions WHERE external_id = 'z1'", []);
  const sp = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'check', reference: '40000', dueDate: '2026-09-09', amount: 555550 }, o, db);
  const cookie = `session=${createSession(o.id)}`;
  const r = await fetch(`${base}/employees/salary/${sp.id}/approve-diff`, {
    method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ txn_id: String(txn.id), note: 'אושר בטלפון' }).toString(),
  });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/employees?saved=diffapproved');
  const after = await db.one('SELECT amount, bank_note, bank_txn_id FROM salary_payments WHERE id = ?', [sp.id]);
  assert.equal(after.amount, 555550, 'הסכום שהוזן נשאר');
  assert.equal(after.bank_note, 'אושר בטלפון');
  const page = await (await fetch(`${base}/employees`, { headers: { cookie } })).text();
  assert.match(page, /הפרש \+₪0\.06 אושר: אושר בטלפון|הפרש \+0\.06/);

  // משתמש שמוגבל לחנות אחרת (אותן הרשאות, סקופ אחר) לא נוגע בשורת השכר הזו — גם לא ב"מחק" /
  // "נפרט" / "בטל התאמה", שעד עכשיו קיבלו כל מזהה.
  const { hashPassword } = await import('../src/lib/auth.js');
  const otherStore = await db.one('SELECT id, company_id FROM stores WHERE company_id <> ? ORDER BY id LIMIT 1', [st.company_id]);
  await db.run(`INSERT INTO users (name, role, username, password_hash, permissions) VALUES ('מוגבל', 'secretary', 'narrow1', ?, 'nav_employees')`, [hashPassword('narrow12345')]);
  const u = await db.one("SELECT id FROM users WHERE username = 'narrow1'", []);
  await db.run('INSERT INTO user_companies (user_id, company_id) VALUES (?, ?)', [u.id, otherStore.company_id]);
  await db.run('INSERT INTO user_stores (user_id, store_id) VALUES (?, ?)', [u.id, otherStore.id]);
  const ucookie = `session=${createSession(u.id)}`;
  for (const action of ['delete', 'uncashed', 'approve-diff']) {
    const res = await fetch(`${base}/employees/salary/${sp.id}/${action}`, {
      method: 'POST', redirect: 'manual', headers: { cookie: ucookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ txn_id: String(txn.id) }).toString(),
    });
    assert.equal(res.status, 404, `${action} מחוץ לסקופ`);
  }
  assert.ok(await db.one('SELECT id FROM salary_payments WHERE id = ?', [sp.id]), 'השורה עדיין קיימת');
});

// 🔗 נצפה: העברות שכר עם אסמכתה מאישור ההעברה באתר (10208425) מול 182750207 בדף החשבון — אותו סכום
// בדיוק, יום אחרי. ההסבר אמר "עדכן את האסמכתה" ולא היה שום כפתור.
test('"התאם לחיוב הזה": אותו סכום, אסמכתה אחרת → משויך, והחיוב יוצא מ"העברות ללא תיעוד"', async () => {
  const { linkSalaryToBankTxn } = await import('../src/services/salaryPayments.js');
  const { setWatchFrom, untrackedTransfers } = await import('../src/services/transfers.js');
  const { db, o, st, acct, emp } = await world();
  await setWatchFrom('2026-01-01', o, db);
  await importTransactions(acct, [{ txnDate: '2026-09-09', amount: -1556481, description: 'העב׳ במקבץ-נט', rawReference: '182750207', externalId: 'w1' }], 'scraper', o, db);
  assert.equal((await untrackedTransfers({ scope: null }, db)).length, 1, 'לפני השיוך — נראית כהעברה ללא תיעוד');
  const sp = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'transfer', reference: '10208425', dueDate: '2026-09-08', amount: 1556481 }, o, db);
  const row = (await attachSalaryBankHints(await listSalaryPayments({}, db), db)).find((r) => r.id === sp.id);
  assert.equal(row.bank_link.reference, '182750207');
  const linked = await linkSalaryToBankTxn(sp.id, row.bank_link.txnId, o, db);
  assert.equal(Number(linked.bank_txn_id), row.bank_link.txnId);
  assert.equal(linked.reference, '10208425', 'האסמכתה שהוזנה נשמרת');
  assert.deepEqual(await untrackedTransfers({ scope: null }, db), [], 'אחרי השיוך — מוסברת');
});

test('"התאם לחיוב הזה" נדחה בסכום שונה או בחיוב רחוק בזמן', async () => {
  const { linkSalaryToBankTxn } = await import('../src/services/salaryPayments.js');
  const { db, o, st, acct, emp } = await world();
  await importTransactions(acct, [
    { txnDate: '2026-09-09', amount: -100001, description: 'העב׳ במקבץ-נט', rawReference: '1', externalId: 'v1' },
    { txnDate: '2026-12-30', amount: -200000, description: 'העב׳ במקבץ-נט', rawReference: '2', externalId: 'v2' },
  ], 'scraper', o, db);
  const t1 = await db.one("SELECT id FROM bank_transactions WHERE external_id = 'v1'", []);
  const t2 = await db.one("SELECT id FROM bank_transactions WHERE external_id = 'v2'", []);
  const a = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'transfer', reference: '9', dueDate: '2026-09-08', amount: 100000 }, o, db);
  const b = await createSalaryPayment({ storeId: st.id, employeeId: emp.id, method: 'transfer', reference: '8', dueDate: '2026-09-08', amount: 200000 }, o, db);
  await assert.rejects(() => linkSalaryToBankTxn(a.id, t1.id, o, db), /הסכום בבנק שונה/);
  await assert.rejects(() => linkSalaryToBankTxn(b.id, t2.id, o, db), /רחוק מדי/);
});
