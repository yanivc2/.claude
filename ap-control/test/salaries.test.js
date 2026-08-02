import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, secretary, firstStore, accountForStore } from './helpers.js';
import { createSalary, listSalaries, deleteSalary, salariesTotal, getSalary } from '../src/services/salaries.js';

test('createSalary stores agorot and defaults', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);
  const s = await createSalary(
    { employeeName: 'דנה כהן', bankAccountId: acct.id, method: 'transfer', reference: 'TRX-1', amount: '8,500.00', payDate: '2026-08-01', period: '2026-07' },
    o,
    db,
  );
  assert.equal(s.amount, 850000);
  assert.equal(s.method, 'transfer');
  assert.equal(s.employee_name, 'דנה כהן');
  assert.equal(s.period, '2026-07');
});

test('cash salary drops the bank account', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const store = await firstStore(db);
  const acct = await accountForStore(db, store.id);
  const s = await createSalary(
    { employeeName: 'עובד', bankAccountId: acct.id, method: 'cash', amount: '3000', payDate: '2026-08-01' },
    o,
    db,
  );
  assert.equal(s.bank_account_id, null);
});

test('createSalary validates name and amount', async () => {
  const db = await freshDb();
  const o = await owner(db);
  await assert.rejects(() => createSalary({ employeeName: '', amount: '100', payDate: '2026-08-01' }, o, db), /עובד/);
  await assert.rejects(() => createSalary({ employeeName: 'x', amount: '0', payDate: '2026-08-01' }, o, db), /חיובי/);
  await assert.rejects(() => createSalary({ employeeName: 'x', amount: '100', payDate: '' }, o, db), /תאריך/);
});

test('listSalaries filters by date range and employee; total sums', async () => {
  const db = await freshDb();
  const o = await owner(db);
  await createSalary({ employeeName: 'דנה', amount: '5000', method: 'cash', payDate: '2026-07-01' }, o, db);
  await createSalary({ employeeName: 'רון', amount: '6000', method: 'cash', payDate: '2026-08-01' }, o, db);
  const july = await listSalaries({ from: '2026-07-01', to: '2026-07-31' }, db);
  assert.equal(july.length, 1);
  assert.equal(july[0].employee_name, 'דנה');
  const byName = await listSalaries({ employee: 'רון' }, db);
  assert.equal(byName.length, 1);
  const tot = await salariesTotal({}, db);
  assert.equal(tot.count, 2);
  assert.equal(tot.total, 1100000);
});

test('deleteSalary is owner-only', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const sec = await secretary(db);
  const s = await createSalary({ employeeName: 'x', amount: '100', method: 'cash', payDate: '2026-08-01' }, o, db);
  await assert.rejects(() => deleteSalary(s.id, sec, db), /בעלים/);
  await deleteSalary(s.id, o, db);
  await assert.rejects(() => getSalary(s.id, db), /לא נמצא/);
});
