// The scrape channel: israeli-bank-scrapers rows → bank_transactions → the R7 matcher, plus the
// intake endpoint that the external runner POSTs to. The scraper library itself is never loaded —
// these tests exercise the pure mapper and the ingest path, which is all the app owns.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { mapScrapedTransactions, scrapedExternalId } from '../src/lib/scraperMap.js';
import { importScrapedBatch } from '../src/services/bankSync.js';
import { createInvoice, approveInvoiceForPayment } from '../src/services/invoices.js';
import { createPayment } from '../src/services/payments.js';
import { listTransactions } from '../src/services/bankTransactions.js';

const ctx = { companyId: 'hapoalim', accountNumber: '412345' };

// --- the pure mapper ---------------------------------------------------------------------------

test('scraped rows map to signed agorot; pending, dateless and zero rows are dropped', () => {
  const rows = mapScrapedTransactions(
    [
      { date: '2026-07-10T00:00:00.000Z', chargedAmount: -1170.5, description: 'צ׳ק', identifier: 5001, status: 'completed' },
      { date: '2026-07-11', chargedAmount: -50, description: 'ממתין', identifier: 5002, status: 'pending' },
      { date: '', chargedAmount: -50, identifier: 5003, status: 'completed' },
      { date: '2026-07-12', chargedAmount: 0, identifier: 5004, status: 'completed' },
      { date: '2026-07-13', chargedAmount: 2000, description: 'הפקדה', identifier: 5005 }, // no status = completed
    ],
    ctx,
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    txnDate: '2026-07-10',
    amount: -117050,
    description: 'צ׳ק',
    rawReference: '5001',
    externalId: 'scr:hapoalim:412345:5001',
  });
  assert.equal(rows[1].amount, 200000);
  assert.ok(!('status' in rows[0]), 'status was only ever a filter, not a column');
});

test('description joins description + memo once; identifier missing → no external id', () => {
  const [row] = mapScrapedTransactions(
    [{ date: '2026-07-10', chargedAmount: -25, description: 'רכישה', memo: 'רכישה' }],
    ctx,
  );
  assert.equal(row.description, 'רכישה');
  assert.equal(row.rawReference, null);
  // A card feed with no identifier falls back to field-equality dedupe rather than a made-up id.
  assert.equal(row.externalId, null);
  assert.equal(scrapedExternalId({ ...ctx, identifier: '  ' }), null);
});

test('the external id is namespaced per institution and account — no cross-channel collision', () => {
  assert.equal(scrapedExternalId({ companyId: 'isracard', accountNumber: '9', identifier: '7' }), 'scr:isracard:9:7');
  assert.notEqual(
    scrapedExternalId({ companyId: 'hapoalim', accountNumber: '1', identifier: '7' }),
    scrapedExternalId({ companyId: 'hapoalim', accountNumber: '2', identifier: '7' }),
  );
});

// --- importing a batch -------------------------------------------------------------------------

test('a scraped batch imports, auto-matches the check, and a re-scrape inserts nothing twice', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);

  await db.run("INSERT INTO suppliers (name, status) VALUES ('טרה', 'approved')", []);
  const sup = await db.one("SELECT * FROM suppliers WHERE name='טרה'", []);
  await createInvoice(
    { supplierId: sup.id, storeId: store.id, invoiceNumber: 'SC-1', invoiceDate: '2026-02-01', amountBeforeVat: 11700, vatAmount: 0, docType: 'tax_invoice' },
    ow, db,
  );
  const inv = await db.one("SELECT id FROM invoices WHERE invoice_number='SC-1'", []);
  await approveInvoiceForPayment(inv.id, ow, db);
  const pay = await createPayment(
    { bankAccountId: ba.id, method: 'check', checkNumber: '6004', paymentDate: '2026-02-05', invoiceIds: [inv.id] },
    ow, db,
  );

  const batch = {
    accounts: [
      {
        // The runner reports the bank's own account number; the app maps it to its bank account.
        accountNumber: ba.account_number,
        transactions: mapScrapedTransactions(
          [
            { date: '2026-02-11', chargedAmount: -117, description: 'שיק', identifier: 6004, status: 'completed' },
            { date: '2026-02-12', chargedAmount: 500, description: 'הפקדה', identifier: 77, status: 'completed' },
          ],
          { companyId: 'hapoalim', accountNumber: ba.account_number },
        ),
      },
    ],
  };

  const first = await importScrapedBatch(batch, ow, db);
  assert.equal(first.accounts, 1);
  assert.equal(first.inserted, 2);
  assert.equal(first.matched, 1, 'the ₪117 debit matched open check 6004');
  assert.deepEqual(first.unmapped, []);
  assert.equal((await db.one('SELECT status FROM payments WHERE id = ?', [pay.id])).status, 'cleared');

  const rows = await listTransactions(ba.id, db);
  assert.equal(rows.every((r) => r.source === 'scraper'), true);

  // Re-scraping the overlapping window is a no-op — external_id dedupes.
  const second = await importScrapedBatch(batch, ow, db);
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 2);
  assert.equal((await listTransactions(ba.id, db)).length, 2);
});

test('an account number the app does not know is reported, never guessed into another ledger', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);

  const r = await importScrapedBatch(
    {
      accounts: [
        { accountNumber: ba.account_number, transactions: [{ txnDate: '2026-02-11', amount: -100, description: 'א', rawReference: null, externalId: 'scr:a:1:1' }] },
        { accountNumber: '99999999', transactions: [{ txnDate: '2026-02-11', amount: -900, description: 'פקמ', rawReference: null, externalId: 'scr:a:2:1' }] },
      ],
    },
    ow, db,
  );
  assert.equal(r.accounts, 1, 'only the known account was imported');
  assert.equal(r.inserted, 1);
  assert.deepEqual(r.unmapped, ['99999999']);
  assert.equal((await listTransactions(ba.id, db)).length, 1);
});

test('an empty batch is refused rather than silently succeeding', async () => {
  const db = await freshDb();
  await assert.rejects(() => importScrapedBatch({ accounts: [] }, null, db), /לא התקבלו חשבונות/);
});

// --- the intake endpoint -----------------------------------------------------------------------

let server, base;
before(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('POST /ingest/bank-txns: disabled without CRON_SECRET, refuses a wrong one, imports with it', async () => {
  const saved = config.cronSecret;
  const db = await freshDb();
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  const body = (accountNumber) =>
    JSON.stringify({
      accounts: [
        {
          accountNumber,
          transactions: [
            { txnDate: '2026-02-11', amount: -25000, description: 'שיק', rawReference: '7777', externalId: 'scr:hapoalim:x:7777' },
          ],
        },
      ],
    });
  const post = (headers, accountNumber = ba.account_number) =>
    fetch(`${base}/ingest/bank-txns`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: body(accountNumber),
    });

  try {
    config.cronSecret = null;
    assert.equal((await post({})).status, 503, 'disabled by default — never open');

    config.cronSecret = 'cr0n';
    assert.equal((await post({ authorization: 'Bearer nope' })).status, 401);

    const res = await post({ authorization: 'Bearer cr0n' });
    assert.equal(res.status, 200);
    const got = await res.json();
    assert.equal(got.ok, true);
    assert.equal(got.inserted, 1);

    const rows = await listTransactions(ba.id, db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, -25000);
    assert.equal(rows[0].raw_reference, '7777');
    assert.equal(rows[0].source, 'scraper');

    // An unknown account number answers 207 — partial, not a failure.
    const partial = await post({ authorization: 'Bearer cr0n' }, '88888888');
    assert.equal(partial.status, 207);
    assert.deepEqual((await partial.json()).unmapped, ['88888888']);
  } finally {
    config.cronSecret = saved;
  }
});
