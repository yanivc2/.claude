// The nightly Open-Banking sync endpoint (/ingest/bank-sync). It sits BEFORE the session gate, so
// its only guard is CRON_SECRET — these tests are about that guard being closed by default.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { freshDb, firstStore, accountForStore } from "./helpers.js";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { listTransactions } from "../src/services/bankTransactions.js";

let server, base;
const realFetch = global.fetch;

before(async () => {
  server = createApp().listen(0);
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  global.fetch = realFetch;
  if (server) server.close();
});

test("bank-sync cron: disabled without CRON_SECRET, refuses a wrong one, syncs with the right one", async () => {
  const savedCron = config.cronSecret;
  const savedKey = config.financy.apiKey;
  // The app resolves the executor per request, so seed a fresh DB here and read back through it.
  const db = await freshDb();
  const store = await firstStore(db);
  const ba = await accountForStore(db, store.id);
  await db.run("UPDATE bank_accounts SET financy_account_id = ? WHERE id = ?", [
    "fin_9",
    ba.id,
  ]);

  try {
    config.cronSecret = null;
    config.financy.apiKey = "test-key";
    let r = await fetch(`${base}/ingest/bank-sync`);
    assert.equal(r.status, 503, "disabled by default — never open");

    config.cronSecret = "cr0n";
    r = await fetch(`${base}/ingest/bank-sync?key=nope`);
    assert.equal(r.status, 401);

    // Vercel Cron authenticates with `Authorization: Bearer $CRON_SECRET`.
    // The stub must pass THIS test's own request to the local server through untouched — only the
    // app's outbound call to the provider is faked.
    global.fetch = async (url, init) => {
      if (String(url).includes("127.0.0.1")) return realFetch(url, init);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          items: [
            {
              SK: "TXN#c1",
              status: "BOOKED",
              entryReference: "7777",
              date: { valueDate: "2026-02-11" },
              amount: { chargedAmount: { amount: -250 } },
              description: { description: "שיק" },
            },
          ],
          nextPage: null,
        }),
      };
    };
    r = await realFetch(`${base}/ingest/bank-sync`, {
      headers: { authorization: "Bearer cr0n" },
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.accounts, 1);
    assert.equal(body.inserted, 1);

    const rows = await listTransactions(ba.id, db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].amount, -25000);
    assert.equal(rows[0].source, "financy");
    assert.equal(rows[0].raw_reference, "7777");
  } finally {
    global.fetch = realFetch;
    config.cronSecret = savedCron;
    config.financy.apiKey = savedKey;
  }
});

test("bank-sync cron: reports 503 when Financy itself is not configured", async () => {
  const savedCron = config.cronSecret;
  const savedKey = config.financy.apiKey;
  try {
    config.cronSecret = "cr0n";
    config.financy.apiKey = null;
    const r = await fetch(`${base}/ingest/bank-sync?key=cr0n`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /FINANCY_API_KEY/);
  } finally {
    config.cronSecret = savedCron;
    config.financy.apiKey = savedKey;
  }
});
