// בעלים (15/10): במידנייט רצף היתרות נשבר ב-25 ימים (13/08–17/09), ובכל יום שבור היו גם שורות
// קובץ וגם שורות משיכה — אותה תנועה פעמיים. (1) קובץ שמגיע אחרי המשיכה לא יכפיל יותר (ויתרתו
// נכנסת לשורה הקיימת). (2) הכפילויות הישנות מאוחדות — רק כשרצף היתרות מוכיח אותן.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { accountIntegrity } from '../src/services/accountIntegrity.js';
import { findAccountDuplicates, mergeAccountDuplicates, pairDuplicates } from '../src/services/bankDuplicates.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let db, o, store, accts;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  store = await firstStore(db);
  accts = (await db.many('SELECT id FROM bank_accounts ORDER BY id', [])).map((r) => Number(r.id));
});
// One bank account per store (UNIQUE), so a test takes a seeded account and empties it.
async function cleanAccount(i) {
  const a = accts[i];
  for (const t of await db.many('SELECT id FROM bank_transactions WHERE bank_account_id = ?', [a])) {
    await db.run('UPDATE deposits SET matched_txn_id = NULL WHERE matched_txn_id = ?', [t.id]);
  }
  await db.run('DELETE FROM bank_transactions WHERE bank_account_id = ?', [a]);
  return a;
}

const ins = (a, date, amount, desc, { bal = null, source = 'csv', ext = null, ref = null } = {}) => db.run(
  `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, balance_after, source, external_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [a, date, amount, desc, ref, bal, source, ext],
);

test('part 1: a file imported AFTER the bank pull does not duplicate it, and lends it its balance', async () => {
  const a = await cleanAccount(1);
  await ins(a, '2026-10-01', -50000, 'העב׳ במקבץ-נט', { source: 'scraper', ext: 'scr:h:1:1' });
  await ins(a, '2026-10-01', 120000, 'הפקדה', { source: 'scraper', ext: 'scr:h:1:2' });
  await ins(a, '2026-10-02', -3000, 'עמלה', { source: 'scraper', ext: 'scr:h:1:3' });
  const r = await importTransactions(a, [
    { txnDate: '2026-10-01', amount: -50000, description: 'העברה במקבץ נט', balanceAfter: 950000 },
    { txnDate: '2026-10-01', amount: 120000, description: 'הפקדת מזומן', balanceAfter: 1070000 },
    { txnDate: '2026-10-03', amount: -3000, description: 'עמלת ניהול', balanceAfter: 1067000 }, // value date, +1 day
    { txnDate: '2026-10-03', amount: -777, description: 'שורה חדשה באמת', balanceAfter: 1066223 },
  ], 'csv', o, db, { fileName: 'midnight.xlsx' });
  assert.equal(r.inserted, 1, 'only the genuinely new line');
  assert.equal(r.merged, 3);
  const rows = await db.many('SELECT * FROM bank_transactions WHERE bank_account_id = ? ORDER BY id', [a]);
  assert.equal(rows.length, 4);
  assert.equal(Number(rows.find((x) => x.external_id === 'scr:h:1:1').balance_after), 950000, 'same-day balance copied onto the pulled row');
  assert.equal(rows.find((x) => x.external_id === 'scr:h:1:3').balance_after, null, 'a balance is never moved to another day');
});

test('part 1: a manual line is a person\'s decision — never swallowed', async () => {
  const a = await cleanAccount(2);
  await ins(a, '2026-10-01', -50000, 'x', { source: 'scraper', ext: 'scr:h:2:1' });
  const r = await importTransactions(a, [{ txnDate: '2026-10-01', amount: -50000, description: 'ידני' }], 'manual', o, db);
  assert.equal(r.inserted, 1);
});

// The pre-27/09 shape: file rows (with balances) + the same lines pulled again (no balance).
async function midnight() {
  const a = await cleanAccount(0);
  // day 1: anchor
  await ins(a, '2026-08-12', -1000, 'עמלה', { bal: 100000 });
  // day 2: two real lines in the file, both pulled again
  await ins(a, '2026-08-13', -30000, 'העברה לספק', { bal: 70000 });
  await ins(a, '2026-08-13', 20000, 'הפקדה', { bal: 90000 });
  const s1 = (await ins(a, '2026-08-13', -30000, 'העב׳ במקבץ-נט', { source: 'scraper', ext: 'scr:hapoalimBiz:12-628-1:5001:2026-08-13:-30000' })).lastInsertRowid;
  await ins(a, '2026-08-13', 20000, 'הפקדת מזומן', { source: 'scraper', ext: 'scr:hapoalimBiz:12-628-1:5002:2026-08-13:20000' });
  // day 3: a clean day where two REAL lines of the same amount exist (file + its own pull is NOT a dup here)
  await ins(a, '2026-08-14', -500, 'עמלה', { bal: 89500 });
  await ins(a, '2026-08-15', -500, 'עמלה', { source: 'scraper', ext: 'scr:hapoalimBiz:12-628-1:5003:2026-08-15:-500' }); // real, next day
  await ins(a, '2026-08-15', 0, 'סגירה', { bal: 89000 });
  return { a, s1 };
}

test('part 2: pairs are proposed only where the balance chain proves the duplicate', async () => {
  const { a } = await midnight();
  const before = await accountIntegrity(a, db);
  assert.equal(before.breaks.length, 1, 'day 2 is broken by the duplicates');
  const d = await findAccountDuplicates(a, db);
  assert.equal(d.mergeable.length, 2, 'both duplicates of the broken day');
  const notDup = d.pairs.find((p) => p.drop.external_id === 'scr:hapoalimBiz:12-628-1:5003:2026-08-15:-500');
  assert.ok(notDup && !notDup.verified, 'a same-amount pair across days is NOT proposed');
  assert.equal(d.breaksBefore, 1);
  assert.equal(d.breaksAfter, 0);
});

test('part 2: merge keeps the file row, gives it the bank id, moves matches, and the chain heals', async () => {
  const { a, s1 } = await midnight();
  const pay = (await db.run(
    "INSERT INTO payments (bank_account_id, method, payment_date, amount, status, created_by) VALUES (?, 'transfer', '2026-08-13', 30000, 'cleared', ?)",
    [a, o.id],
  )).lastInsertRowid;
  await db.run('UPDATE bank_transactions SET matched_payment_id = ? WHERE id = ?', [pay, s1]);
  const dep = (await db.run(
    "INSERT INTO deposits (store_id, deposit_date, amount, deposited, created_by, matched_txn_id) VALUES (?, '2026-08-13', 20000, 1, ?, (SELECT id FROM bank_transactions WHERE external_id = 'scr:hapoalimBiz:12-628-1:5002:2026-08-13:20000'))",
    [store.id, o.id],
  )).lastInsertRowid;

  const r = await mergeAccountDuplicates(a, o, db);
  assert.equal(r.merged, 2);
  assert.equal(r.movedLinks, 2);
  const keepT = await db.one("SELECT * FROM bank_transactions WHERE bank_account_id = ? AND description = 'העברה לספק'", [a]);
  assert.equal(keepT.external_id, 'scr:hapoalimBiz:12-628-1:5001:2026-08-13:-30000', 'the next pull recognises it and does not re-insert');
  assert.equal(Number(keepT.matched_payment_id), Number(pay), 'the payment match moved to the row that stayed');
  const keepD = await db.one("SELECT * FROM bank_transactions WHERE bank_account_id = ? AND description = 'הפקדה'", [a]);
  assert.equal(Number((await db.one('SELECT matched_txn_id FROM deposits WHERE id = ?', [dep])).matched_txn_id), Number(keepD.id));
  assert.equal(Number((await db.one('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?', [a])).n), 6);
  assert.equal((await accountIntegrity(a, db)).breaks.length, 0, 'the balance chain is whole again');
  // a re-pull of the same lines does not bring them back
  const again = await importTransactions(a, [
    { txnDate: '2026-08-13', amount: -30000, description: 'העב׳ במקבץ-נט', externalId: 'scr:hapoalimBiz:12-628-1:5001:2026-08-13:-30000' },
    { txnDate: '2026-08-13', amount: 20000, description: 'הפקדת מזומן', externalId: 'scr:hapoalimBiz:12-628-1:5002:2026-08-13:20000' },
  ], 'scraper', o, db);
  assert.equal(again.inserted, 0);
  await assert.rejects(() => mergeAccountDuplicates(a, o, db), /אין כפילויות מאומתות/);
});

test('part 2: a pair whose two halves are matched to different payments is not merged', async () => {
  const { a, s1 } = await midnight();
  const p1 = (await db.run("INSERT INTO payments (bank_account_id, method, payment_date, amount, status, created_by) VALUES (?, 'transfer', '2026-08-13', 30000, 'cleared', ?)", [a, o.id])).lastInsertRowid;
  const p2 = (await db.run("INSERT INTO payments (bank_account_id, method, payment_date, amount, status, created_by) VALUES (?, 'transfer', '2026-08-13', 30000, 'cleared', ?)", [a, o.id])).lastInsertRowid;
  const f1 = await db.one("SELECT id FROM bank_transactions WHERE bank_account_id = ? AND description = 'העברה לספק'", [a]);
  await db.run('UPDATE bank_transactions SET matched_payment_id = ? WHERE id = ?', [p1, f1.id]);
  await db.run('UPDATE bank_transactions SET matched_payment_id = ? WHERE id = ?', [p2, s1]);
  const d = await findAccountDuplicates(a, db);
  const p = d.pairs.find((x) => Number(x.drop.id) === Number(s1));
  assert.match(p.conflict, /תשלומים שונים/);
  assert.ok(!d.mergeable.includes(p));
});

test('a pulled line WITHOUT a bank id (no reference from the bank) is a twin too — and stays merged', async () => {
  const a = await cleanAccount(3);
  await ins(a, '2026-08-12', -1000, 'עמלה', { bal: 100000 });
  await ins(a, '2026-08-13', 25000, 'הפקדת מזומן', { bal: 125000 });
  await ins(a, '2026-08-13', 25000, 'הפקדה בסניף', { source: 'scraper' }); // no external_id
  const d = await findAccountDuplicates(a, db);
  assert.equal(d.mergeable.length, 1);
  assert.equal((await mergeAccountDuplicates(a, o, db)).merged, 1);
  assert.equal((await accountIntegrity(a, db)).breaks.length, 0);
  // the next pull brings the same id-less line again — it is recognised as the file row, not re-inserted
  const again = await importTransactions(a, [{ txnDate: '2026-08-13', amount: 25000, description: 'הפקדה בסניף' }], 'scraper', o, db);
  assert.equal(again.inserted, 0);
  assert.equal(again.merged, 1);
  // …while a genuinely new id-less line still lands
  const fresh = await importTransactions(a, [{ txnDate: '2026-08-20', amount: 999, description: 'חדש' }], 'scraper', o, db);
  assert.equal(fresh.inserted, 1);
});

test('the Midnight shape: the file row was adopted (current id) and an OLD channel pulled it again', async () => {
  const a = await cleanAccount(3);
  const cur = (ref, date, amt) => `scr:hapoalimBiz:12-628-432110:${ref}:${date}:${amt}`;
  await ins(a, '2026-08-12', -1000, 'עמלה', { bal: 100000, ext: cur('9', '2026-08-12', -1000) });
  // the file line, adopted by today's agent
  await ins(a, '2026-08-13', -40000, 'העברה', { bal: 60000, ext: cur('77', '2026-08-13', -40000) });
  // the same line from the old external scraper (another channel → another id)
  const stale = (await ins(a, '2026-08-13', -40000, 'העב׳ במקבץ-נט', { source: 'scraper', ext: 'scr:hapoalim:432110:77:2026-08-13:-40000' })).lastInsertRowid;
  // today's agent: a later import batch, so its channel is "current"
  await db.run("UPDATE bank_transactions SET source = 'scraper', import_id = NULL WHERE bank_account_id = ? AND external_id LIKE 'scr:hapoalimBiz:%' AND balance_after IS NULL", [a]);
  const imp = (await db.run("INSERT INTO bank_imports (bank_account_id, source, rows_total) VALUES (?, 'scraper', 1)", [a])).lastInsertRowid;
  await ins(a, '2026-08-20', -5, 'עמלה', { source: 'scraper', ext: cur('8', '2026-08-20', -5) });
  await db.run('UPDATE bank_transactions SET import_id = ? WHERE bank_account_id = ? AND txn_date = ?', [imp, a, '2026-08-20']);

  const d = await findAccountDuplicates(a, db);
  assert.equal(d.mergeable.length, 1, 'the stale copy is proposed');
  assert.equal(Number(d.mergeable[0].drop.id), Number(stale));
  assert.equal(d.mergeable[0].takeId, false, "an old channel's id is not handed on");
  await mergeAccountDuplicates(a, o, db);
  assert.equal((await accountIntegrity(a, db)).breaks.length, 0);
  // today's agent pulls the line again — the file row already carries its id
  const again = await importTransactions(a, [{ txnDate: '2026-08-13', amount: -40000, description: 'x', externalId: cur('77', '2026-08-13', -40000) }], 'scraper', o, db);
  assert.equal(again.inserted, 0);
});

test('two rows that both carry the CURRENT channel id are never paired', async () => {
  const rows = [
    { id: 1, txn_date: '2026-08-13', amount: -500, source: 'scraper', external_id: 'scr:hapoalimBiz:1:a:2026-08-13:-500', balance_after: null, import_id: 2 },
    { id: 2, txn_date: '2026-08-14', amount: -500, source: 'scraper', external_id: 'scr:hapoalimBiz:1:b:2026-08-14:-500', balance_after: null, import_id: 2 },
  ];
  assert.equal(pairDuplicates(rows).length, 0, 'two real fees of the same amount');
});

test('the page always says what it checked, even when there is nothing to merge', async () => {
  const a = await cleanAccount(2);
  const d = await findAccountDuplicates(a, db);
  assert.equal(d.pairs.length, 0);
  assert.equal(typeof d.fileRows, 'number');
});

test('pairing is one-to-one and prefers the same date', () => {
  const rows = [
    { id: 1, txn_date: '2026-08-13', amount: -500, source: 'csv', external_id: null, balance_after: 1 },
    { id: 2, txn_date: '2026-08-14', amount: -500, source: 'csv', external_id: null, balance_after: 2 },
    { id: 3, txn_date: '2026-08-14', amount: -500, source: 'scraper', external_id: 'a', balance_after: null },
    { id: 4, txn_date: '2026-08-13', amount: -500, source: 'scraper', external_id: 'b', balance_after: null },
  ];
  const pairs = pairDuplicates(rows).map((p) => [p.keep.id, p.drop.id]).sort();
  assert.deepEqual(pairs, [[1, 4], [2, 3]]);
  // a file row that already carries a current bank id is not paired with another current-id pull
  const both = pairDuplicates([
    { id: 1, txn_date: '2026-08-13', amount: -500, source: 'csv', external_id: 'x', balance_after: 1 },
    { id: 2, txn_date: '2026-08-13', amount: -500, source: 'scraper', external_id: 'y', balance_after: null },
  ]);
  assert.equal(both.length, 0);
});

let server, base;
before(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('route: merging is owner-only, and the page shows the proposal', async () => {
  const { a } = await midnight();
  const sec = await secretary(db);
  const post = (uid) => fetch(`${base}/reconciliation/integrity/merge`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ account_id: String(a) }).toString(),
    headers: { cookie: `session=${createSession(uid)}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const page = await (await fetch(`${base}/reconciliation/integrity?account=${a}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(page, /1א\. אותה תנועה פעמיים בחשבון הזה/);
  assert.match(page, /נבדקו \d+ שורות מקובץ מול \d+ שורות שנמשכו מהבנק/);
  assert.match(page, /אחד 2 כפילויות מאומתות/);
  assert.ok([302, 303, 403].includes((await post(sec.id)).status) && (await db.one('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?', [a])).n == 8, 'a secretary cannot delete bank rows');
  const r = await post(o.id);
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /אוחדו 2 כפילויות/);
});
