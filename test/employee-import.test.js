import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { parseEmployeeFile, normalizePhone } from '../src/lib/employeeImport.js';
import { importEmployees, createEmployee, listEmployees } from '../src/services/employees.js';
import { lastReconciliationFor } from '../src/services/reports.js';

test('normalizePhone folds the 972 country code to a local leading zero', () => {
  assert.equal(normalizePhone('972-50-2288123'), '0502288123');
  assert.equal(normalizePhone('050-2288123'), '0502288123');
  assert.equal(normalizePhone(''), '');
});

test('parseEmployeeFile reads name+phone headers, splits a full name, drops nameless rows', () => {
  const csv = 'שם,טלפון\nדנה כהן,054-1112222\nיוסי לוי,0501234567\n,0559998888\n';
  const { rows, stats } = parseEmployeeFile(Buffer.from(csv, 'utf8'));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { firstName: 'דנה', lastName: 'כהן', phone: '0541112222' });
  assert.equal(stats.skippedNoName, 1);
});

test('importEmployees dedupes by phone against existing and within the file', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await createEmployee({ firstName: 'קיים', lastName: 'עובד', phone: '050-2288123' }, ow, db);
  const rows = [
    { firstName: 'דנה', lastName: 'כהן', phone: '0541112222' },
    { firstName: 'כפיל', lastName: 'טלפון', phone: '972-50-2288123' }, // same person as the seed → skip
    { firstName: 'רונית', lastName: 'בר', phone: '' },                 // no phone → always added
  ];
  const res = await importEmployees(rows, ow, db);
  assert.deepEqual(res, { added: 2, skipped: 1, invalid: 0 });
  const all = await listEmployees({ includeInactive: true }, db);
  assert.equal(all.length, 3); // seed + 2
});

test('lastReconciliationFor is per store (matched bank transactions) and picks latest for all', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const accts = await db.many(
    `SELECT ba.id AS acct, ba.store_id FROM bank_accounts ba ORDER BY ba.store_id`, [],
  );
  const a = accts[0];
  const b = accts[1];
  // A matched (reconciled) transaction on each store's account, store B's later than A's.
  const pA = await db.run(
    `INSERT INTO payments (bank_account_id, method, amount, status, payment_date, created_by)
     VALUES (?, 'check', 1000, 'cleared', '2026-08-01', ?)`, [a.acct, ow.id]);
  const pB = await db.run(
    `INSERT INTO payments (bank_account_id, method, amount, status, payment_date, created_by)
     VALUES (?, 'check', 2000, 'cleared', '2026-08-20', ?)`, [b.acct, ow.id]);
  await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, matched_payment_id)
     VALUES (?, '2026-08-01', -1000, ?)`, [a.acct, pA.lastInsertRowid]);
  await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, matched_payment_id)
     VALUES (?, '2026-08-20', -2000, ?)`, [b.acct, pB.lastInsertRowid]);
  // An UNmatched transaction must not count.
  await db.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, matched_payment_id)
     VALUES (?, '2026-09-01', -500, NULL)`, [a.acct]);

  const forA = await lastReconciliationFor(null, a.store_id, db);
  const forB = await lastReconciliationFor(null, b.store_id, db);
  const forAll = await lastReconciliationFor(null, null, db);
  assert.equal(String(forA.ts).slice(0, 10), '2026-08-01'); // ignores the later unmatched txn
  assert.equal(String(forB.ts).slice(0, 10), '2026-08-20');
  assert.equal(String(forAll.ts).slice(0, 10), '2026-08-20'); // latest across stores
  assert.ok(forAll.storeName); // names which store the latest reconciliation belongs to

  // A store with no matched transactions reports nothing (dashboard shows "—", never another store's date).
  const other = accts.find((r) => r.store_id !== a.store_id && r.store_id !== b.store_id);
  if (other) assert.equal(await lastReconciliationFor(null, other.store_id, db), null);
});
