// The Financy (Open Banking) → bank_transactions mapping. Pure, no network — this is where all the
// provider-format knowledge lives, so it is where the regressions get caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapFinancyTransaction,
  mapFinancyTransactions,
  matchFinancyAccount,
  financyReference,
  financyTxnDate,
  isBookedFinancyTxn,
} from '../src/lib/financyMap.js';

// A cleared check as the provider sends it: chargedAmount already negative, entryReference = the
// check number (that is what makes deterministic matching possible).
const clearedCheck = {
  id: 'tx_1',
  SK: 'TXN#2026-02-11#abc',
  accountId: 'acc_1',
  status: 'BOOKED',
  entryReference: '6004',
  code: '013',
  date: { valueDate: '2026-02-11', bookingDate: '2026-02-12', transactionDate: '2026-02-10' },
  amount: { chargedAmount: { amount: -1170.5, currency: 'ILS' }, originalAmount: { amount: -1170.5, currency: 'ILS' } },
  description: { description: 'שיק', additionalInfo: 'משיכת שיק' },
  balancePerEndDay: 42350.25,
};

test('a cleared check maps to a signed-agorot debit with the check number as the reference', () => {
  const r = mapFinancyTransaction(clearedCheck);
  assert.equal(r.txnDate, '2026-02-11'); // valueDate wins over booking/transaction date
  assert.equal(r.amount, -117050); // debit stays negative; float dust rounded away
  assert.equal(r.rawReference, '6004');
  assert.equal(r.balanceAfter, 4235025);
  assert.equal(r.externalId, 'TXN#2026-02-11#abc'); // SK preferred over id
  assert.match(r.description, /שיק/);
});

test('amounts round to agorot instead of inheriting float dust', () => {
  const r = mapFinancyTransaction({ ...clearedCheck, amount: { chargedAmount: { amount: 11.7 } } });
  assert.equal(r.amount, 1170); // not 1169
});

test('a credit (money in) stays positive', () => {
  const r = mapFinancyTransaction({ ...clearedCheck, amount: { chargedAmount: { amount: 5000 } } });
  assert.equal(r.amount, 500000);
});

test('pending, deleted and provider-duplicate lines are skipped', () => {
  assert.equal(mapFinancyTransaction({ ...clearedCheck, status: 'PENDING' }), null);
  assert.equal(mapFinancyTransaction({ ...clearedCheck, status: 'pending' }), null); // casing
  assert.equal(mapFinancyTransaction({ ...clearedCheck, status: 'DELETED' }), null);
  assert.equal(mapFinancyTransaction({ ...clearedCheck, isDuplicate: true }), null);
  // A missing status has always meant booked on this feed.
  assert.ok(isBookedFinancyTxn({}));
  assert.ok(mapFinancyTransaction({ ...clearedCheck, status: undefined }));
});

test('rows with no usable date or amount are skipped, not imported as garbage', () => {
  assert.equal(mapFinancyTransaction({ ...clearedCheck, date: {} }), null);
  assert.equal(mapFinancyTransaction({ ...clearedCheck, amount: {} }), null);
  assert.equal(mapFinancyTransaction({ ...clearedCheck, amount: { chargedAmount: { amount: 0 } } }), null);
  assert.equal(mapFinancyTransaction(null), null);
});

test('originalAmount is the fallback when chargedAmount is absent', () => {
  const r = mapFinancyTransaction({ ...clearedCheck, amount: { originalAmount: { amount: -80 } } });
  assert.equal(r.amount, -8000);
});

test('the date falls back booking → transaction when there is no value date', () => {
  assert.equal(financyTxnDate({ date: { bookingDate: '2026-03-01T00:00:00Z' } }), '2026-03-01');
  assert.equal(financyTxnDate({ date: { transactionDate: '2026-03-02' } }), '2026-03-02');
  assert.equal(financyTxnDate({ date: {} }), '');
});

test('the reference falls back to the provider code, never to nothing usable', () => {
  assert.equal(financyReference({ entryReference: '  7001 ' }), '7001');
  assert.equal(financyReference({ entryReference: '', code: '013' }), '013');
  assert.equal(financyReference({}), null);
});

test('the description joins the provider fields once, without repeats', () => {
  const r = mapFinancyTransaction({
    ...clearedCheck,
    description: { description: 'העברה', additionalInfo: 'העברה' },
    merchantName: 'טרה',
  });
  assert.equal(r.description, 'העברה — טרה');
});

test('mapFinancyTransactions drops the skipped rows and keeps order', () => {
  const rows = mapFinancyTransactions([
    clearedCheck,
    { ...clearedCheck, SK: 'b', status: 'PENDING' },
    { ...clearedCheck, SK: 'c', entryReference: '6005' },
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.rawReference), ['6004', '6005']);
  assert.deepEqual(mapFinancyTransactions(null), []);
});

// --- account matching -----------------------------------------------------------------------

test('an account matches on branch + number, ignoring leading zeros', () => {
  const provider = [
    { id: 'f1', parsedAccount: { bank: '12', branch: '0645', number: '00412345' } },
    { id: 'f2', parsedAccount: { bank: '12', branch: '0645', number: '999' } },
  ];
  const hit = matchFinancyAccount(provider, { branch: '645', account_number: '412345' });
  assert.equal(hit.id, 'f1');
});

test('a provider that reports no branch still matches on the account number alone', () => {
  const provider = [{ id: 'f1', accountNumber: '412345' }];
  assert.equal(matchFinancyAccount(provider, { branch: '645', account_number: '412345' })?.id, 'f1');
});

test('no match and an ambiguous match both refuse — never guess which bank account to pull', () => {
  const provider = [
    { id: 'f1', parsedAccount: { branch: '645', number: '412345' } },
    { id: 'f2', parsedAccount: { branch: '645', number: '412345' } },
  ];
  assert.equal(matchFinancyAccount(provider, { branch: '645', account_number: '412345' }), null, 'ambiguous');
  assert.equal(matchFinancyAccount(provider, { branch: '645', account_number: '777' }), null, 'none');
  assert.equal(matchFinancyAccount(provider, { branch: '645', account_number: '' }), null, 'no number to match on');
});
