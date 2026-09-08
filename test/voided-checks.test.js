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

// --- the link each reason demands ---------------------------------------------------------------
//
// The order below is the real one, and it is why the link is attached AFTER the void: while the
// check still pays the invoice, the invoice is 'paid' and a replacement payment is refused. So
// "שינוי אמצעי תשלום" is always void → re-issue → link, from the צ'קים מבוטלים page.

test('a replacement cannot even be recorded before the void — hence post-void linking', async () => {
  const { db, ow, acct, check } = await world();
  const p = await check('7010', '2026-03-01', 40000);
  const line = await db.one('SELECT invoice_id FROM payment_lines WHERE payment_id = ?', [p.id]);
  await assert.rejects(
    () => createPayment(
      { bankAccountId: acct.id, method: 'transfer', reference: 'TR-9', paymentDate: '2026-03-05', invoiceIds: [line.invoice_id] },
      ow, db,
    ),
    /paid/,
    'the invoice is still paid by the check being replaced',
  );
});

test('void → re-issue → link clears the "ללא קישור" status', async () => {
  const { db, ow, acct, check } = await world();
  const p = await check('7020', '2026-03-01', 40000);
  const line = await db.one('SELECT invoice_id FROM payment_lines WHERE payment_id = ?', [p.id]);

  await voidPaymentWithReason(p.id, { reason: 'method_changed' }, ow, db);
  let row = (await listVoidedChecks({ scope: null }, db))[0].rows.find((r) => r.check_number === '7020');
  assert.equal(row.status.key, 'unlinked', 'until it is linked, the page chases it');

  // Now the invoice is open again, so the replacement can be recorded…
  await approveInvoiceForPayment(line.invoice_id, ow, db);
  const replacement = await createPayment(
    { bankAccountId: acct.id, method: 'transfer', reference: 'TR-20', paymentDate: '2026-03-06', invoiceIds: [line.invoice_id] },
    ow, db,
  );
  // …and only now can it be offered as the link.
  const { voidLinkOptions, setVoidLink } = await import('../src/services/voidedChecks.js');
  const opts = await voidLinkOptions(p.id, db);
  assert.ok(opts.payments.map((r) => Number(r.id)).includes(replacement.id));
  assert.ok(!opts.payments.map((r) => Number(r.id)).includes(p.id), 'never the check being voided');

  await setVoidLink(p.id, { linkPaymentId: replacement.id }, ow, db);
  row = (await listVoidedChecks({ scope: null }, db))[0].rows.find((r) => r.check_number === '7020');
  assert.equal(Number(row.void_link_payment_id), replacement.id);
  // No longer an alarm. Which of 'live'/'expired' it lands on depends only on the calendar.
  assert.ok(!row.status.alarm, 'linked → no longer chased');
  assert.ok(['live', 'expired'].includes(row.status.key));
});

test('ביטול שורה בתוכנה links to the invoice the check paid — available at void time', async () => {
  const { db, ow, check } = await world();
  const p = await check('7021', '2026-03-01', 30000);
  const line = await db.one('SELECT invoice_id FROM payment_lines WHERE payment_id = ?', [p.id]);
  const { voidLinkOptions } = await import('../src/services/voidedChecks.js');
  const opts = await voidLinkOptions(p.id, db);
  assert.deepEqual(opts.invoices.map((i) => Number(i.id)), [Number(line.invoice_id)]);

  await voidPaymentWithReason(p.id, { reason: 'row_cancelled', linkInvoiceId: line.invoice_id }, ow, db);
  const row = (await listVoidedChecks({ scope: null }, db))[0].rows.find((r) => r.check_number === '7021');
  assert.equal(Number(row.void_link_invoice_id), Number(line.invoice_id));
  assert.ok(!row.status.alarm, 'linked at void time → never chased');
});

test('a link is refused on a live check, and needs something to point at', async () => {
  const { db, ow, check } = await world();
  const p = await check('7022');
  const { setVoidLink } = await import('../src/services/voidedChecks.js');
  await assert.rejects(() => setVoidLink(p.id, { linkInvoiceId: 1 }, ow, db), /צ׳ק מבוטל/);
  await voidPaymentWithReason(p.id, { reason: 'row_cancelled' }, ow, db);
  await assert.rejects(() => setVoidLink(p.id, {}, ow, db), /לבחור תשלום או חשבונית/);
});

// --- the nightly sweep --------------------------------------------------------------------------
//
// Two of the four reasons have a DEADLINE rather than a state: "לא נאסף" becomes safe on a date,
// and an unmatched/unlinked one only gets worse with time. Nothing a user does would notice either,
// so the sweep also runs on a cron (GET /ingest/voided-checks, guarded by CRON_SECRET).

test('the cron endpoint is disabled without a secret, refuses a wrong one, and sweeps with it', async () => {
  const { createApp } = await import('../src/app.js');
  const { config } = await import('../src/config.js');
  const { once } = await import('node:events');
  const saved = config.cronSecret;
  const { db, ow, check } = await world();
  const p = await check('7030', '2026-03-01', 20000);
  await voidPaymentWithReason(p.id, { reason: 'cashed_for_salary' }, ow, db); // owes a match

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    config.cronSecret = null;
    assert.equal((await fetch(`${base}/ingest/voided-checks`)).status, 503, 'disabled by default, never open');

    config.cronSecret = 'cr0n';
    assert.equal((await fetch(`${base}/ingest/voided-checks?key=nope`)).status, 401);

    const res = await fetch(`${base}/ingest/voided-checks`, { headers: { authorization: 'Bearer cr0n' } });
    assert.equal(res.status, 200);
    const got = await res.json();
    assert.equal(got.ok, true);
    assert.equal(got.problems, 1, 'the unmatched salary void was reported');

    // …and a second run is silent: void_alerted remembers what was already said.
    const again = await (await fetch(`${base}/ingest/voided-checks?key=cr0n`)).json();
    assert.equal(again.problems, 0, 'idempotent — a quiet night sends nothing');
  } finally {
    config.cronSecret = saved;
    server.close();
  }
});

test('a "לא נאסף" check is announced once it passes six months, and only once', async () => {
  const { db, ow, check } = await world();
  const { alertOnExpiredNotCollected } = await import('../src/services/voidedChecks.js');

  const old = await check('7040', '2025-01-01', 15000);   // long past six months
  const fresh = await check('7041', '2026-09-01', 15000); // still live
  await voidPaymentWithReason(old.id, { reason: 'not_collected' }, ow, db);
  await voidPaymentWithReason(fresh.id, { reason: 'not_collected' }, ow, db);

  assert.equal(await alertOnExpiredNotCollected(db), 1, 'only the expired one');
  assert.equal(await alertOnExpiredNotCollected(db), 0, 'and never twice');
  const row = await db.one('SELECT void_alerted FROM payments WHERE id = ?', [old.id]);
  assert.equal(row.void_alerted, 'expired');
});

test('before the owner runs the DB upgrade, both pages say so instead of erroring', async () => {
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');
  const { db, ow } = await world();

  // Simulate a live database that has the deploy but not yet the upgrade: the columns and the
  // table are simply absent. (SQLite only — the production case is Postgres, but the code path is
  // the same probe, and pg-mem cannot drop a column with a dependent index.)
  if (process.env.TEST_PG === '1') return;
  await db.run('DROP TABLE salary_payments', []);
  await db.run('ALTER TABLE payments DROP COLUMN void_reason', []);

  const server = createApp().listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { cookie: `session=${encodeURIComponent(createSession(ow.id))}` };
  try {
    for (const path of ['/voided-checks', '/employees']) {
      const res = await fetch(base + path, { headers });
      const html = await res.text();
      assert.equal(res.status, 200, `${path} must render, not 500`);
      assert.ok(html.includes('נדרש עדכון מסד נתונים'), `${path} tells the owner what to do`);
      assert.ok(!html.includes('does not exist'), `${path} never shows the raw SQL error`);
    }
  } finally {
    server.close();
  }
});
