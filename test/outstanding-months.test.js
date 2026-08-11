import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { outstandingChecks, outstandingCheckDetail, outstandingMonths } from '../src/services/reports.js';

async function issueCheck(x, acctId, ownerId, date, amount, num) {
  await x.run(
    `INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by)
     VALUES (?, 'check', ?, ?, ?, 'issued', ?)`,
    [acctId, num, date, amount, ownerId],
  );
}

test('outstandingMonths lists a contiguous month range from earliest to latest check', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const st = await firstStore(x);
  const acct = await accountForStore(x, st.id);
  await issueCheck(x, acct.id, o.id, '2025-12-15', 10000, 'A1');
  await issueCheck(x, acct.id, o.id, '2026-02-20', 20000, 'A2'); // gap over Jan 2026

  const months = await outstandingMonths(null, x);
  assert.deepEqual(months.map((m) => m.value), ['2025-12', '2026-01', '2026-02']);
  assert.equal(months[0].label, 'דצמבר 2025');
});

test('month cut filters both the account summary and the detail', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const st = await firstStore(x);
  const acct = await accountForStore(x, st.id);
  await issueCheck(x, acct.id, o.id, '2025-12-15', 10000, 'B1');
  await issueCheck(x, acct.id, o.id, '2026-02-20', 20000, 'B2');

  const all = await outstandingChecks(null, {}, x);
  assert.equal(all.totalOutstanding, 30000);

  const dec = await outstandingChecks(null, { month: '2025-12' }, x);
  assert.equal(dec.totalOutstanding, 10000);
  const decAcct = dec.accounts.find((a) => a.id === acct.id);
  assert.equal(decAcct.outstanding_count, 1);

  const detail = await outstandingCheckDetail(acct.id, { month: '2026-02' }, x);
  assert.equal(detail.length, 1);
  assert.equal(detail[0].amount, 20000);
});

test('outstandingMonths is empty when nothing is outstanding', async () => {
  const x = await freshDb();
  assert.deepEqual(await outstandingMonths(null, x), []);
});
