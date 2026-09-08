// A voided check is not a closed matter: in Israel it stays presentable for six months, so the
// software's "voided" tells the books one thing and the bank nothing. These tests pin the parts
// that make that safe — the reason each void carries, the follow-up it demands, the six-month
// clock, and the alarm when the bank pays one anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment, voidPaymentWithReason } from '../src/services/payments.js';
import { createEmployee } from '../src/services/employees.js';
import { createZClosing } from '../src/services/zclosing.js';
import {
  listVoidedChecks, checkStatus, CHECK_LIFE_DAYS, voidReasonLabel, VOID_REASON_VALUES,
  cashedVoidedChecks,
} from '../src/services/voidedChecks.js';
import { createSalaryPayment, markCashed, cashExpenseCandidates } from '../src/services/salaryPayments.js';
import { addDaysIso } from '../src/lib/loginHours.js';

async function world() {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);
  await db.run("INSERT INTO suppliers (name, status) VALUES ('ספק', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name = 'ספק'", []);
  let n = 0;
  const check = async (checkNumber, date = '2026-03-01', amount = 50000) => {
    n += 1;
    await createInvoice(
      { supplierId: sup.id, storeId: store.id, invoiceNumber: `V-${n}`, invoiceDate: date,
        amountBeforeVat: amount, vatAmount: 0, docType: 'tax_invoice' },
      ow, db,
    );
    const inv = await db.one('SELECT id FROM invoices WHERE invoice_number = ?', [`V-${n}`]);
    await approveInvoiceForPayment(inv.id, ow, db);
    return createPayment(
      { bankAccountId: acct.id, method: 'check', checkNumber, paymentDate: date, invoiceIds: [inv.id] },
      ow, db,
    );
  };
  return { db, ow, store, acct, sup, check };
}

test('the void reason is one of four, and an unknown one is refused', async () => {
  const { db, ow, check } = await world();
  assert.deepEqual(VOID_REASON_VALUES, ['not_collected', 'cashed_for_salary', 'method_changed', 'row_cancelled']);
  const p = await check('7001');
  await assert.rejects(
    () => voidPaymentWithReason(p.id, { reason: 'because' }, ow, db),
    /סיבת ביטול לא תקינה/,
  );
  assert.equal(voidReasonLabel('not_collected'), 'לא נאסף');
});

test('a voided check keeps who/when/why, and lands on the page grouped by store', async () => {
  const { db, ow, store, check } = await world();
  const p = await check('7002');
  await voidPaymentWithReason(p.id, { reason: 'not_collected' }, ow, db);

  const groups = await listVoidedChecks({ scope: null }, db);
  assert.equal(groups.length, 1, 'one rubric per store');
  assert.equal(groups[0].storeId, store.id);
  const [row] = groups[0].rows;
  assert.equal(row.check_number, '7002');
  assert.equal(row.void_reason, 'not_collected');
  assert.ok(row.voided_at, 'the void is stamped with its time');
  assert.equal(row.voided_by_name, ow.name);
  assert.match(row.for_text, /ספק/, 'the page says who the check was for');
});

test('the six-month clock: live until it expires, then safe', async () => {
  const base = { payment_date: '2026-03-01', void_reason: 'not_collected' };
  const safeFrom = addDaysIso('2026-03-01', CHECK_LIFE_DAYS);

  const live = checkStatus(base, '2026-06-01');
  assert.equal(live.key, 'live');
  assert.match(live.label, new RegExp(safeFrom));

  assert.equal(checkStatus(base, addDaysIso(safeFrom, -1)).key, 'live', 'the day before is still live');
  assert.equal(checkStatus(base, safeFrom).key, 'expired', 'and on the day itself it is safe');
});

test('a reason whose follow-up was never done is flagged, and clears once it is', () => {
  const day = '2026-04-01';
  const salary = { payment_date: '2026-03-01', void_reason: 'cashed_for_salary' };
  assert.equal(checkStatus(salary, day).key, 'unmatched');
  assert.equal(checkStatus({ ...salary, void_cash_expense_id: 5 }, day).key, 'live');

  const method = { payment_date: '2026-03-01', void_reason: 'method_changed' };
  assert.equal(checkStatus(method, day).key, 'unlinked');
  assert.equal(checkStatus({ ...method, void_link_payment_id: 9 }, day).key, 'live');

  const row = { payment_date: '2026-03-01', void_reason: 'row_cancelled' };
  assert.equal(checkStatus(row, day).key, 'unlinked');
  assert.equal(checkStatus({ ...row, void_link_invoice_id: 3 }, day).key, 'live');
});

test('🔴 a voided check the bank paid anyway is the alarm, whatever its reason', async () => {
  const { db, ow, acct, check } = await world();
  const p = await check('7003', '2026-03-01', 50000);
  await voidPaymentWithReason(p.id, { reason: 'not_collected' }, ow, db);
  assert.equal((await cashedVoidedChecks({ scope: null }, db)).length, 0);

  // The bank statement shows the check going out — same account, same amount, its number in the row.
  await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, '2026-05-20', ?, 'שיק 7003', '7003', 'csv')`,
    [acct.id, -50000],
  );

  const alarmed = await cashedVoidedChecks({ scope: null }, db);
  assert.equal(alarmed.length, 1, 'the money left the account after the void');
  assert.equal(alarmed[0].check_number, '7003');
  assert.equal(alarmed[0].status.key, 'cashed');
  assert.equal(alarmed[0].status.alarm, true);

  // …and it outranks the countdown: expiry no longer matters once the money is gone.
  const groups = await listVoidedChecks({ scope: null }, db);
  assert.equal(groups[0].rows[0].status.label, 'נפרע אחרי הביטול!');
});

test('a different amount or a different account is NOT that check', async () => {
  const { db, ow, acct, check } = await world();
  const p = await check('7004', '2026-03-01', 50000);
  await voidPaymentWithReason(p.id, { reason: 'not_collected' }, ow, db);
  await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, '2026-05-20', ?, 'שיק 7004', '7004', 'csv')`,
    [acct.id, -49900],
  );
  assert.equal((await cashedVoidedChecks({ scope: null }, db)).length, 0, 'the amount must match too');
});

// --- the wage check cashed at the till ----------------------------------------------------------

test('THE CASE: an employee cashes the wage check at the till — the check is voided and matched', async () => {
  const { db, ow, store, acct, check } = await world();
  const emp = await createEmployee({ firstName: 'אורי', lastName: 'בר', phone: '050-1122334' }, ow, db);

  // The wage check, and the till payout recorded on that day's Z closing.
  const p = await check('7005', '2026-03-01', 600000);
  await createZClosing(
    { employeeFirst: 'אורי', employeeLast: 'בר', zNumber: '700', drawerCash: 100000, storeId: store.id,
      counts: {}, registers: [],
      expenses: [{ kind: 'salary', payerName: 'אורי בר', purpose: 'פריטת צ׳ק שכר', amount: 600000, employeeId: emp.id }] },
    ow, db,
  );
  const expense = await db.one('SELECT id FROM z_closing_expenses ORDER BY id DESC LIMIT 1', []);

  const wage = await createSalaryPayment(
    { storeId: store.id, employeeId: emp.id, method: 'check', reference: '7005', dueDate: '2026-03-01', amount: 600000 },
    ow, db,
  );
  await db.run('UPDATE salary_payments SET payment_id = ? WHERE id = ?', [p.id, wage.id]);

  // The offered candidates are the unclaimed till payouts.
  const cands = await cashExpenseCandidates({ storeId: store.id, scope: null }, db);
  assert.ok(cands.some((c) => Number(c.id) === Number(expense.id)));

  const after = await markCashed(wage.id, expense.id, ow, db);
  assert.equal(Number(after.cashed), 1);
  assert.equal(Number(after.cash_expense_id), Number(expense.id));

  // The underlying check is voided with the right reason, and already carries its match — so the
  // page shows it as tracked rather than as a problem.
  const pay = await db.one('SELECT status, void_reason, void_cash_expense_id FROM payments WHERE id = ?', [p.id]);
  assert.equal(pay.status, 'voided');
  assert.equal(pay.void_reason, 'cashed_for_salary');
  assert.equal(Number(pay.void_cash_expense_id), Number(expense.id));
  assert.equal(checkStatus({ ...pay, payment_date: '2026-03-01' }, '2026-04-01').key, 'live');

  // A matched till payout is not offered to a second wage row.
  const left = await cashExpenseCandidates({ storeId: store.id, scope: null }, db);
  assert.ok(!left.some((c) => Number(c.id) === Number(expense.id)));
});

test('the same till payout cannot be claimed twice', async () => {
  const { db, ow, store } = await world();
  const emp = await createEmployee({ firstName: 'נועם', lastName: 'ג', phone: '050-5566778' }, ow, db);
  await createZClosing(
    { employeeFirst: 'נועם', employeeLast: 'ג', zNumber: '701', drawerCash: 1000, storeId: store.id,
      counts: {}, registers: [], expenses: [{ kind: 'manual', payerName: 'נועם ג', purpose: 'פריטה', amount: 30000 }] },
    ow, db,
  );
  const expense = await db.one('SELECT id FROM z_closing_expenses ORDER BY id DESC LIMIT 1', []);
  const mk = (ref) => createSalaryPayment(
    { storeId: store.id, employeeId: emp.id, method: 'check', reference: ref, dueDate: '2026-03-05', amount: 30000 },
    ow, db,
  );
  const a = await mk('8001');
  const b = await mk('8002');
  await markCashed(a.id, expense.id, ow, db);
  await assert.rejects(() => markCashed(b.id, expense.id, ow, db), /כבר שויכה/);
});

test('a wage payment needs an employee, a real date, a positive amount and an identifier', async () => {
  const { db, ow, store } = await world();
  const emp = await createEmployee({ firstName: 'ש', lastName: 'ל', phone: '050-9090909' }, ow, db);
  const base = { storeId: store.id, employeeId: emp.id, method: 'check', reference: '9001', dueDate: '2026-03-01', amount: 1000 };
  await assert.rejects(() => createSalaryPayment({ ...base, employeeId: null }, ow, db), /לבחור עובד/);
  await assert.rejects(() => createSalaryPayment({ ...base, dueDate: '8/9/26' }, ow, db), /תאריך תקין/);
  await assert.rejects(() => createSalaryPayment({ ...base, amount: 0 }, ow, db), /גדול מאפס/);
  await assert.rejects(() => createSalaryPayment({ ...base, reference: '' }, ow, db), /אסמכתה/);
  // Cash needs no identifier — there is nothing to reconcile it against.
  const ok = await createSalaryPayment({ ...base, method: 'cash', reference: '' }, ow, db);
  assert.equal(ok.method, 'cash');
});
