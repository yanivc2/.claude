// End-to-end Open-Banking sync: Financy's JSON → bank_transactions → the R7 matcher, with the
// provider stubbed at `fetch`. Proves the two properties that make a scheduled sync safe:
// re-pulling an overlapping window inserts nothing twice, and a pulled check debit auto-matches.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { config } from '../src/config.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { syncBankAccount, syncAllLinkedAccounts, linkFinancyAccounts, daysAgoInIsrael } from '../src/services/bankSync.js';
import { listTransactions } from '../src/services/bankTransactions.js';

const realFetch = global.fetch;
const realKey = config.financy.apiKey;

/** Stub the provider: `accounts` answers /data/accounts, `transactions` answers /data/transactions. */
function stubFinancy({ accounts = [], transactions = [] }) {
  const calls = [];
  global.fetch = async (url) => {
    const u = new URL(String(url));
    calls.push(u);
    const items = u.pathname.endsWith('/data/accounts') ? accounts : transactions;
    return { ok: true, status: 200, json: async () => ({ items, nextPage: null }) };
  };
  return calls;
}

beforeEach(() => { config.financy.apiKey = 'test-key'; });
afterEach(() => { global.fetch = realFetch; config.financy.apiKey = realKey; });

const txn = (over = {}) => ({
  SK: 'TXN#1',
  status: 'BOOKED',
  entryReference: '6004',
  date: { valueDate: '2026-02-11' },
  amount: { chargedAmount: { amount: -117, currency: 'ILS' } },
  description: { description: 'שיק' },
  ...over,
});

test('linkFinancyAccounts links by branch + account number and is idempotent', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);

  stubFinancy({
    accounts: [{ id: 'fin_9', parsedAccount: { branch: ba.branch, number: ba.account_number } }],
  });

  const first = await linkFinancyAccounts(ow, db);
  assert.equal(first.linked.length, 1);
  assert.equal(first.linked[0].financyAccountId, 'fin_9');
  const row = await db.one('SELECT financy_account_id FROM bank_accounts WHERE id = ?', [ba.id]);
  assert.equal(row.financy_account_id, 'fin_9');

  // A second run leaves the existing link alone rather than re-writing it.
  const second = await linkFinancyAccounts(ow, db);
  assert.equal(second.linked.length, 0);
  assert.equal(second.alreadyLinked, 1);
});

test('an unlinked account refuses to sync instead of pulling the wrong bank account', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  stubFinancy({ transactions: [txn()] });
  await assert.rejects(() => syncBankAccount(ba.id, {}, ow, db), /לא מקושר/);
});

test('sync imports the movements, auto-matches the check, and a re-pull inserts nothing twice', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run('UPDATE bank_accounts SET financy_account_id = ? WHERE id = ?', ['fin_9', ba.id]);

  // An open check for ₪117 — the debit the bank is about to report.
  await db.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='טרה'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'S-1', invoiceDate: '2026-02-01', amountBeforeVat: 11700, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT id FROM invoices WHERE invoice_number='S-1'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  const pay = await createPayment(
    { bankAccountId: ba.id, method: 'check', checkNumber: '6004', paymentDate: '2026-02-05', invoiceIds: [inv.id] },
    ow, db,
  );

  const calls = stubFinancy({ transactions: [txn(), txn({ SK: 'TXN#2', entryReference: '9', amount: { chargedAmount: { amount: 500 } } })] });

  const first = await syncBankAccount(ba.id, {}, ow, db);
  assert.equal(first.fetched, 2);
  assert.equal(first.inserted, 2);
  assert.equal(first.skipped, 0);
  assert.equal(first.matched, 1, 'the ₪117 debit matched the open check 6004');

  // The request went to the linked provider account, over a window ending today.
  assert.equal(calls.at(-1).searchParams.get('accountId'), 'fin_9');
  assert.equal(calls.at(-1).searchParams.get('dateFrom'), daysAgoInIsrael(config.financy.syncDays));

  const cleared = await db.one('SELECT * FROM payments WHERE id = ?', [pay.id]);
  assert.equal(cleared.status, 'cleared');

  // Re-pulling the same (overlapping) window is a no-op — external_id dedupes even though the
  // bank restated the description and value date on the second pull.
  stubFinancy({
    transactions: [
      txn({ description: { description: 'שיק — נפרע' }, date: { valueDate: '2026-02-12' } }),
      txn({ SK: 'TXN#2', entryReference: '9', amount: { chargedAmount: { amount: 500 } } }),
    ],
  });
  const second = await syncBankAccount(ba.id, {}, ow, db);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 2);
  assert.equal((await listTransactions(ba.id, db)).length, 2, 'still two rows, not four');
});

test('a provider error surfaces as an actionable Hebrew message, not a raw failure', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run('UPDATE bank_accounts SET financy_account_id = ? WHERE id = ?', ['fin_9', ba.id]);

  global.fetch = async () => ({ ok: false, status: 403, text: async () => 'plan' });
  await assert.rejects(() => syncBankAccount(ba.id, {}, ow, db), /Starter/);

  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(() => syncBankAccount(ba.id, {}, ow, db), /FINANCY_API_KEY/);
});

test('with no API key configured the sync refuses instead of half-working', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run('UPDATE bank_accounts SET financy_account_id = ? WHERE id = ?', ['fin_9', ba.id]);
  config.financy.apiKey = null;
  await assert.rejects(() => syncBankAccount(ba.id, {}, ow, db), /לא מוגדר/);
});

// --- the nightly scheduler ---------------------------------------------------------------------

test('syncAllLinkedAccounts covers every linked account and one failure never stops the rest', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const stores = await db.many('SELECT id FROM stores ORDER BY id', []);
  assert.ok(stores.length >= 2, 'the seed has more than one store');
  const accts = await db.many('SELECT id FROM bank_accounts ORDER BY id', []);
  assert.ok(accts.length >= 2);

  // Link the first two; leave any others unlinked so they are skipped, not attempted.
  await db.run('UPDATE bank_accounts SET financy_account_id = ? WHERE id = ?', ['fin_a', accts[0].id]);
  await db.run('UPDATE bank_accounts SET financy_account_id = ? WHERE id = ?', ['fin_b', accts[1].id]);

  // fin_a answers; fin_b fails — a bank that is briefly unreachable must not lose fin_a's rows.
  global.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.searchParams.get('accountId') === 'fin_b') {
      return { ok: false, status: 429, text: async () => 'slow down' };
    }
    return { ok: true, status: 200, json: async () => ({ items: [txn()], nextPage: null }) };
  };

  const r = await syncAllLinkedAccounts({}, ow, db);
  assert.equal(r.accounts, 2, 'only the linked accounts are attempted');
  assert.equal(r.inserted, 1);
  assert.equal(r.results.length, 1);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /429/);
  // fin_a's row is committed despite fin_b failing.
  assert.equal((await listTransactions(accts[0].id, db)).length, 1);
});

test('with no linked accounts the scheduled run is a clean no-op', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  stubFinancy({ transactions: [txn()] });
  const r = await syncAllLinkedAccounts({}, ow, db);
  assert.deepEqual({ accounts: r.accounts, inserted: r.inserted, errors: r.errors.length }, { accounts: 0, inserted: 0, errors: 0 });
});
