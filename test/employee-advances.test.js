// מפרעות והלוואות לעובד — הספר של "כמה הוא חייב", וההחזרים שמורידים את היתרה.
//
// מה שנשבר לפני זה: הרובריקה קראה רק שורות מפרעה מדוח Z, כלומר כסף שיצא מהקופה. מפרעה שניתנה
// בהעברה או בצ׳ק לא הופיעה בשום מקום, ולהחזר לא היה איפה להירשם — הסכום נשאר תלוי לנצח.
// שלושת הדברים שנבדקים כאן הם בדיוק אלה: רישום ידני, החזר שמוריד יתרה, ומפרעה מ-Z שגם עליה
// אפשר לרשום החזר בלי שהיא תיכפל בכל טעינה של הדף.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import {
  createAdvance, repayAdvance, deleteRepayment, deleteAdvance, listAdvances, openBalances,
  syncZAdvances, advancesReady,
} from '../src/services/employeeAdvances.js';
import { createEmployee } from '../src/services/employees.js';
import { createSalaryPayment } from '../src/services/salaryPayments.js';

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const sec = await secretary(db);
  const store = await firstStore(db);
  const emp = await createEmployee({ firstName: 'דנה', lastName: 'לוי' }, ow, db);
  return { db, ow, sec, store, emp };
}
const ADV = (store, emp) => ({
  storeId: store.id, employeeId: emp.id, kind: 'advance',
  issuedDate: '2026-09-01', amount: 100000, method: 'transfer', reference: 'TR-1',
});

test('the schema probe answers before anything else touches the tables', async () => {
  const { db } = await world();
  assert.equal(await advancesReady(db), true);
});

test('an advance that never went through the register can be recorded, with how it was paid', async () => {
  const { db, ow, store, emp } = await world();
  const a = await createAdvance(ADV(store, emp), ow, db);
  assert.equal(a.amount, 100000);
  assert.equal(a.method, 'transfer');
  assert.equal(a.z_expense_id, null, 'nothing to do with a Z — this is the gap it fills');

  const [row] = await listAdvances({ scope: null }, db);
  assert.equal(row.balance, 100000, 'nothing repaid yet → the whole sum is owed');
  assert.equal(row.repaid, 0);
  assert.equal(row.status, 'open');
  assert.equal(row.fromZ, false);
});

test('repayments come off the balance, and the last one closes it', async () => {
  const { db, ow, store, emp } = await world();
  const a = await createAdvance(ADV(store, emp), ow, db);

  let out = await repayAdvance(a.id, { repaidDate: '2026-09-20', amount: 40000, source: 'salary' }, ow, db);
  assert.equal(out.balance, 60000);
  assert.equal(out.closed, false);
  let [row] = await listAdvances({ scope: null }, db);
  assert.equal(row.status, 'partial');
  assert.equal(row.repaid, 40000);

  out = await repayAdvance(a.id, { repaidDate: '2026-10-20', amount: 60000, source: 'salary' }, ow, db);
  assert.equal(out.closed, true);
  [row] = await listAdvances({ scope: null }, db);
  assert.equal(row.status, 'repaid');
  assert.equal(row.balance, 0);
  assert.equal(row.repayments.length, 2, 'each instalment is kept — a loan is repaid in pieces');
});

test('🔴 a repayment can never exceed the balance, and none is accepted once it is closed', async () => {
  const { db, ow, store, emp } = await world();
  const a = await createAdvance(ADV(store, emp), ow, db);
  await assert.rejects(
    () => repayAdvance(a.id, { repaidDate: '2026-09-20', amount: 100001, source: 'salary' }, ow, db),
    /גדול מהיתרה/, 'overpaying is not a repayment — it would quietly turn into a credit',
  );
  await repayAdvance(a.id, { repaidDate: '2026-09-20', amount: 100000, source: 'salary' }, ow, db);
  await assert.rejects(
    () => repayAdvance(a.id, { repaidDate: '2026-10-01', amount: 100, source: 'salary' }, ow, db),
    /הוחזרה במלואה/,
  );
  await assert.rejects(
    () => repayAdvance(a.id, { repaidDate: '2026-10-01', amount: -500, source: 'salary' }, ow, db),
    /גדול מאפס/, 'a negative repayment would grow the debt silently',
  );
});

test('a repayment may be tied to the wage it was deducted from — but not to another employee\'s', async () => {
  const { db, ow, store, emp } = await world();
  const other = await createEmployee({ firstName: 'רון', lastName: 'כהן' }, ow, db);
  const a = await createAdvance(ADV(store, emp), ow, db);
  const mine = await createSalaryPayment(
    { storeId: store.id, employeeId: emp.id, method: 'transfer', reference: 'S-1', dueDate: '2026-09-30', amount: 500000 }, ow, db,
  );
  const theirs = await createSalaryPayment(
    { storeId: store.id, employeeId: other.id, method: 'transfer', reference: 'S-2', dueDate: '2026-09-30', amount: 400000 }, ow, db,
  );

  await assert.rejects(
    () => repayAdvance(a.id, { repaidDate: '2026-09-30', amount: 10000, source: 'salary', salaryPaymentId: theirs.id }, ow, db),
    /עובד אחר/, 'picking the wrong row in the combo must not settle somebody else\'s debt',
  );
  await repayAdvance(a.id, { repaidDate: '2026-09-30', amount: 10000, source: 'salary', salaryPaymentId: mine.id }, ow, db);
  const [row] = await listAdvances({ scope: null }, db);
  assert.equal(Number(row.repayments[0].salary_payment_id), Number(mine.id));
  assert.equal(row.repayments[0].salary_reference, 'S-1', 'the screen can show which wage it came off');
});

test('undoing a repayment gives the balance back', async () => {
  const { db, ow, store, emp } = await world();
  const a = await createAdvance(ADV(store, emp), ow, db);
  const out = await repayAdvance(a.id, { repaidDate: '2026-09-20', amount: 40000, source: 'cash' }, ow, db);
  await deleteRepayment(out.repaymentId, ow, db);
  const [row] = await listAdvances({ scope: null }, db);
  assert.equal(row.balance, 100000);
  assert.equal(row.status, 'open');
});

test('an advance entered on a Z is mirrored here, is repayable, and never doubles', async () => {
  const { db, ow, store, emp } = await world();
  const z = await db.run(
    `INSERT INTO z_reports (store_id, z_number, z_date, daily_total, created_by)
     VALUES (?, 'Z-77', '2026-09-02', 500000, ?)`, [store.id, ow.id],
  );
  await db.run(
    `INSERT INTO z_expenses (z_report_id, description_type, employee_id, amount, expense_date)
     VALUES (?, 'advance', ?, 25000, '2026-09-02')`, [z.lastInsertRowid, emp.id],
  );

  assert.equal((await syncZAdvances(db)).inserted, 1);
  assert.equal((await syncZAdvances(db)).inserted, 0, 'a second page load must not create a second debt');

  const [row] = await listAdvances({ scope: null }, db);
  assert.equal(row.amount, 25000);
  assert.equal(row.fromZ, true);
  assert.equal(row.method, 'register');

  // The point of mirroring: a register advance is repayable like any other.
  await repayAdvance(row.id, { repaidDate: '2026-09-25', amount: 25000, source: 'salary' }, ow, db);
  const [after] = await listAdvances({ scope: null }, db);
  assert.equal(after.status, 'repaid');
});

test('the Z owns the amount — a corrected Z line corrects the debt, not the other way round', async () => {
  const { db, ow, store, emp } = await world();
  const z = await db.run(
    `INSERT INTO z_reports (store_id, z_number, z_date, daily_total, created_by)
     VALUES (?, 'Z-78', '2026-09-03', 500000, ?)`, [store.id, ow.id],
  );
  const exp = await db.run(
    `INSERT INTO z_expenses (z_report_id, description_type, employee_id, amount, expense_date)
     VALUES (?, 'advance', ?, 25000, '2026-09-03')`, [z.lastInsertRowid, emp.id],
  );
  await syncZAdvances(db);
  await db.run('UPDATE z_expenses SET amount = 30000 WHERE id = ?', [exp.lastInsertRowid]);
  assert.equal((await syncZAdvances(db)).updated, 1);
  assert.equal((await listAdvances({ scope: null }, db))[0].amount, 30000);

  // A Z line that was deleted never happened — unless somebody already repaid against it.
  await db.run('DELETE FROM z_expenses WHERE id = ?', [exp.lastInsertRowid]);
  assert.equal((await syncZAdvances(db)).removed, 1);
  assert.equal((await listAdvances({ scope: null }, db)).length, 0);
});

test('🔴 a mirrored advance cannot be deleted here, nor one that already has repayments', async () => {
  const { db, ow, store, emp } = await world();
  const z = await db.run(
    `INSERT INTO z_reports (store_id, z_number, z_date, daily_total, created_by)
     VALUES (?, 'Z-79', '2026-09-04', 500000, ?)`, [store.id, ow.id],
  );
  await db.run(
    `INSERT INTO z_expenses (z_report_id, description_type, employee_id, amount, expense_date)
     VALUES (?, 'advance', ?, 25000, '2026-09-04')`, [z.lastInsertRowid, emp.id],
  );
  await syncZAdvances(db);
  const mirrored = (await listAdvances({ scope: null }, db))[0];
  await assert.rejects(() => deleteAdvance(mirrored.id, ow, db), /דוח Z/,
    'deleting it here would come back on the next sync and look like a failed delete');

  const manual = await createAdvance(ADV(store, emp), ow, db);
  await repayAdvance(manual.id, { repaidDate: '2026-09-20', amount: 1000, source: 'cash' }, ow, db);
  await assert.rejects(() => deleteAdvance(manual.id, ow, db), /החזרים/);
});

test('open balances are per employee, and a closed advance drops out of them', async () => {
  const { db, ow, store, emp } = await world();
  const a = await createAdvance(ADV(store, emp), ow, db);
  await createAdvance({ ...ADV(store, emp), amount: 30000, reference: 'TR-2' }, ow, db);
  let [bal] = await openBalances({ scope: null }, db);
  assert.equal(bal.balance, 130000);
  assert.equal(bal.open, 2);

  await repayAdvance(a.id, { repaidDate: '2026-09-20', amount: 100000, source: 'salary' }, ow, db);
  [bal] = await openBalances({ scope: null }, db);
  assert.equal(bal.balance, 30000, 'a settled advance is no longer a debt');
  assert.equal(bal.open, 1);
});

test('🔒 an advance belongs to a store, and another company never sees it', async () => {
  const { db, ow, store, emp } = await world();
  await createAdvance(ADV(store, emp), ow, db);
  const other = await db.one('SELECT id, company_id FROM stores WHERE company_id <> (SELECT company_id FROM stores WHERE id = ?) LIMIT 1', [store.id]);
  assert.equal((await listAdvances({ scope: null }, db)).length, 1);
  if (other) {
    const scoped = await listAdvances({ scope: { companyIds: [Number(other.company_id)], storeIds: [Number(other.id)] } }, db);
    assert.equal(scoped.length, 0, 'another branch does not see this debt');
  }
});
