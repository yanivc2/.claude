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

// סופר על הדרך, 07/09: "תיקון (תאריך ערך 06/09)" — ‎-51,920 / ‎+51,905 ועמלת שטרי כסף ‎-22.38, אותה
// אסמכתא. משיכה אחת החזירה 06/09 (ואימצה את שורות הקובץ), הבאה 07/09 — מזהה אחר, נקלט שוב.
// הפער ברצף: ‎+37.38 בדיוק.
const ID = (ref, date, amt) => `scr:hapoalimBiz:12-628-420244:${ref}:${date}:${amt}`;
async function superShape() {
  const a = await cleanAccount(0);
  await ins(a, '2026-09-05', -100, 'עמלה', { bal: 100000, ext: ID('1', '2026-09-05', -100) });
  for (const [amt, bal, desc] of [[-51920, 48080, 'תיקון'], [51905, 99985, 'תיקון'], [-2238, 97747, 'עמלת שטרי כסף']]) {
    await ins(a, '2026-09-07', amt, desc, { bal, ext: ID('216404133', '2026-09-06', amt), ref: '216404133' }); // adopted on the 06/09 pull
  }
  for (const amt of [-51920, 51905, -2238]) {
    await ins(a, '2026-09-07', amt, 'תיקון (תאריך ערך: 06/09)', { source: 'scraper', ext: ID('216404133', '2026-09-07', amt), ref: '216404133' });
  }
  return a;
}

test('Super al HaDerech: the break explains itself — three lines counted twice, +37.38 exactly', async () => {
  const a = await superShape();
  const r = await accountIntegrity(a, db);
  assert.equal(r.breaks.length, 1);
  assert.equal(r.breaks[0].diff, 2253);
  assert.equal(r.breaks[0].suspects.length, 3);
  assert.ok(r.breaks[0].suspects.every((x) => x.why === 'twice'));
});

test('…and 1א merges them: the file rows stay and take the NEWER id (the date the bank reports now)', async () => {
  const a = await superShape();
  const d = await findAccountDuplicates(a, db);
  assert.equal(d.mergeable.length, 3);
  assert.ok(d.mergeable.every((p) => p.replaceId));
  await mergeAccountDuplicates(a, o, db);
  assert.equal((await accountIntegrity(a, db)).breaks.length, 0, 'the chain is whole');
  const ids = (await db.many("SELECT external_id FROM bank_transactions WHERE bank_account_id = ? AND txn_date = '2026-09-07'", [a])).map((x) => x.external_id).sort();
  assert.deepEqual(ids, [ID('216404133', '2026-09-07', -2238), ID('216404133', '2026-09-07', -51920), ID('216404133', '2026-09-07', 51905)].sort());
  // the next pull reports 07/09 again → recognised, nothing inserted
  const again = await importTransactions(a, [-51920, 51905, -2238].map((amt) => ({ txnDate: '2026-09-07', amount: amt, description: 'x', rawReference: '216404133', externalId: ID('216404133', '2026-09-07', amt) })), 'scraper', o, db);
  assert.equal(again.inserted, 0);
});

test('importer: a line whose date moved between pulls takes the new id instead of landing twice', async () => {
  const a = await cleanAccount(0);
  await ins(a, '2026-09-07', -2238, 'עמלה', { bal: 1, ext: ID('216404133', '2026-09-06', -2238), ref: '216404133' });
  const pull = [
    { txnDate: '2026-09-05', amount: -100, description: 'x', externalId: ID('1', '2026-09-05', -100) },
    { txnDate: '2026-09-07', amount: -2238, description: 'עמלה', rawReference: '216404133', externalId: ID('216404133', '2026-09-07', -2238) },
  ];
  const r = await importTransactions(a, pull, 'scraper', o, db);
  assert.equal(r.restated, 1);
  assert.equal(r.inserted, 1, 'only the genuinely new line');
  const row = await db.one('SELECT external_id FROM bank_transactions WHERE bank_account_id = ? AND amount = -2238', [a]);
  assert.equal(row.external_id, ID('216404133', '2026-09-07', -2238));
});

test('importer: two REAL lines with the same reference and amount (both in the pull) are both kept', async () => {
  const a = await cleanAccount(0);
  await ins(a, '2026-09-06', -500, 'עמלה', { source: 'scraper', ext: ID('77', '2026-09-06', -500), ref: '77' });
  const pull = [
    { txnDate: '2026-09-06', amount: -500, description: 'עמלה', rawReference: '77', externalId: ID('77', '2026-09-06', -500) },
    { txnDate: '2026-09-07', amount: -500, description: 'עמלה', rawReference: '77', externalId: ID('77', '2026-09-07', -500) },
  ];
  const r = await importTransactions(a, pull, 'scraper', o, db);
  assert.equal(r.restated, 0, 'the old id is still reported → it is another transaction');
  assert.equal(r.inserted, 1);
});

// סופר על הדרך — המקרה האמיתי (בעלים, 16/10: אחרי ·228 השבר נשאר, ו-1א: "0 זוגות אפשריים", 270 מ-273
// שורות הקובץ עם מזהה). אין עותק מהמשיכה: **שני קבצים** — הקודם הציג את ה"תיקון" ב-06/09, הבא ב-07/09.
// היום של 06/09 עובר (לעותקים יתרה משלהם, והיתרה של העמלה היא בדיוק הצפויה), והשבר כולו ב-07/09.
// המספרים מדף הבנק, באגורות: סגירת 06/09 ‎-154,076.45, סגירת 07/09 ‎-196,214.92.
const mkImport = async (a, name) => Number((await db.run(
  'INSERT INTO bank_imports (bank_account_id, source, file_name, rows_total) VALUES (?, ?, ?, ?)', [a, 'csv', name, 0],
)).lastInsertRowid);
const insImp = (a, imp, date, amount, desc, bal, { ref = null, ext = null } = {}) => db.run(
  `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, balance_after, source, external_id, import_id)
   VALUES (?, ?, ?, ?, ?, ?, 'csv', ?, ?)`,
  [a, date, amount, desc, ref, bal, ext, imp],
);
const FIX = [[-5192000, -20599645], [5190500, -15409145], [-2238, -15411383]];
async function superTwoFiles() {
  const a = await cleanAccount(0);
  const f1 = await mkImport(a, 'על הדרך.xlsx');
  const f2 = await mkImport(a, 'על הדרך.xlsx');
  await insImp(a, f1, '2026-09-05', -10000, 'עמלה', -15396645, { ref: '1', ext: ID('1', '2026-09-05', -10000) });
  await insImp(a, f1, '2026-09-06', -11000, 'שיק', -15407645, { ref: '26401', ext: ID('26401', '2026-09-06', -11000) });
  for (const [amt, bal] of FIX) await insImp(a, f1, '2026-09-06', amt, 'תיקון', bal, { ref: '216404133' }); // the older export
  for (const [amt, bal] of FIX) await insImp(a, f2, '2026-09-07', amt, 'תיקון (תאריך ערך: 06/09)', bal, { ref: '216404133', ext: ID('216404133', '2026-09-07', amt) });
  await insImp(a, f2, '2026-09-07', -4210109, 'שיק', -19621492, { ref: '26478', ext: ID('26478', '2026-09-07', -4210109) });
  return a;
}

test('Super, the real shape: two files a day apart — the break names the three lines counted twice', async () => {
  const a = await superTwoFiles();
  const r = await accountIntegrity(a, db);
  assert.equal(r.breaks.length, 1);
  const b = r.breaks[0];
  assert.equal(b.date, '2026-09-07');
  assert.equal(b.expected, -19625230, '‎-196,252.30 — as on the owner\'s screen');
  assert.equal(b.found, -19621492, '‎-196,214.92');
  assert.equal(b.diff, 3738);
  assert.equal(b.suspects.length, 3);
  assert.ok(b.suspects.every((x) => x.why === 'twice' && String(x.date).startsWith('2026-09-06')), 'the older copies (no bank id)');
  assert.ok(b.around.length >= 8, 'the rows around the break are shown');
});

test('…1א proposes them (verified by the chain) and the merge keeps the 07/09 rows with their bank id', async () => {
  const a = await superTwoFiles();
  const d = await findAccountDuplicates(a, db);
  assert.equal(d.mergeable.length, 3);
  assert.ok(d.mergeable.every((p) => p.kind === 'days' && String(p.drop.txn_date).startsWith('2026-09-06')));
  assert.equal(d.breaksBefore, 1);
  assert.equal(d.breaksAfter, 0);
  const m = await mergeAccountDuplicates(a, o, db);
  assert.equal(m.merged, 3);
  assert.equal((await accountIntegrity(a, db)).breaks.length, 0, 'the chain is whole');
  const left = await db.many("SELECT txn_date, external_id FROM bank_transactions WHERE bank_account_id = ? AND raw_reference = '216404133'", [a]);
  assert.equal(left.length, 3);
  assert.ok(left.every((x) => String(x.txn_date).startsWith('2026-09-07') && x.external_id));
});

test('two REAL lines a day apart (same amount and reference) are not proposed — the chain is whole with both', async () => {
  const a = await cleanAccount(0);
  const f1 = await mkImport(a, 'a.xlsx');
  const f2 = await mkImport(a, 'b.xlsx');
  await insImp(a, f1, '2026-09-05', -100, 'עמלה', 100000, { ref: '9' });
  await insImp(a, f1, '2026-09-06', -500, 'עמלה חודשית', 99500, { ref: '77' });
  await insImp(a, f2, '2026-09-07', -500, 'עמלה חודשית', 99000, { ref: '77' });
  const d = await findAccountDuplicates(a, db);
  assert.equal(d.mergeable.length, 0);
  assert.equal((await accountIntegrity(a, db)).breaks.length, 0);
});

test('importer: a second file that moved a line to the next day moves the existing row instead of adding it', async () => {
  const a = await cleanAccount(0);
  const row = (date, amount, description, balanceAfter, rawReference) => ({ txnDate: date, amount, description, balanceAfter, rawReference });
  await importTransactions(a, [
    row('2026-09-05', -10000, 'עמלה', -15396645, '1'),
    row('2026-09-06', -11000, 'שיק', -15407645, '26401'),
    ...FIX.map(([amt, bal]) => row('2026-09-06', amt, 'תיקון', bal, '216404133')),
  ], 'csv', o, db, { fileName: 'על הדרך.xlsx' });
  const r = await importTransactions(a, [
    row('2026-09-06', -11000, 'שיק', -15407645, '26401'),
    ...FIX.map(([amt, bal]) => row('2026-09-07', amt, 'תיקון (תאריך ערך: 06/09)', bal, '216404133')),
    row('2026-09-07', -4210109, 'שיק', -19621492, '26478'),
  ], 'csv', o, db, { fileName: 'על הדרך.xlsx' });
  assert.equal(r.restated, 3);
  assert.equal(r.inserted, 1, 'only the check');
  assert.equal((await accountIntegrity(a, db)).breaks.length, 0, 'the chain is whole');
  const fixes = await db.many("SELECT txn_date, description FROM bank_transactions WHERE bank_account_id = ? AND raw_reference = '216404133'", [a]);
  assert.ok(fixes.every((x) => String(x.txn_date).startsWith('2026-09-07') && /תאריך ערך/.test(x.description)));
  // the same second file again → nothing new
  const again = await importTransactions(a, [row('2026-09-07', -4210109, 'שיק', -19621492, '26478'),
    ...FIX.map(([amt, bal]) => row('2026-09-07', amt, 'תיקון (תאריך ערך: 06/09)', bal, '216404133'))], 'csv', o, db);
  assert.equal(again.inserted, 0);
});

test('importer: a file that still lists the old line on its old date keeps both (two real lines)', async () => {
  const a = await cleanAccount(0);
  const row = (date, amount, balanceAfter) => ({ txnDate: date, amount, description: 'עמלה חודשית', balanceAfter, rawReference: '77' });
  await importTransactions(a, [row('2026-09-06', -500, 99500)], 'csv', o, db);
  const r = await importTransactions(a, [row('2026-09-06', -500, 99500), row('2026-09-07', -500, 99000)], 'csv', o, db);
  assert.equal(r.restated, 0);
  assert.equal(r.inserted, 1);
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?', [a])).n, 2);
});

test('route: the page shows the rows around the break and offers the two-file merge', async () => {
  const a = await superTwoFiles();
  const page = await (await fetch(`${base}/reconciliation/integrity?account=${a}`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(page, /שורות שנקלטו <strong>פעמיים<\/strong>/);
  assert.match(page, /השורות אצלנו סביב השבר \(\d+\)/);
  assert.match(page, /קובץ קודם, תאריך אחר/);
  assert.match(page, /אחד 3 כפילויות מאומתות/);
});

// בעלים, 16/10 — "משהו קרה פה": משיכה של 02/10 שמרה 403 שורות כשמשיכה רגילה שומרת 10-90. הסוכן מושך
// 60 יום אחורה, אז 403 "חדשות" אחרי 4 ימים = המזהה של אותן תנועות השתנה. אבחון בלבד: מה השתנה במזהה.
import { pullTwinPairs, idDiff } from '../src/services/bankDuplicates.js';
const PR = (id, imp, ranAt, date, amount, ref, ext) => ({ id, import_id: imp, imported_at: ranAt, import_source: 'scraper', source: 'scraper', txn_date: date, amount, raw_reference: ref, external_id: ext });

test('pull twins: the same transaction again in a later pull (id changed) is found, and what changed is named', () => {
  const rows = [
    PR(1, 10, '2026-09-28 01:41:00', '2026-09-15', -5000, '777', 'scr:hapoalimBiz:12-628-1:777:2026-09-15:-5000'),
    PR(2, 11, '2026-10-02 18:03:00', '2026-09-15', -5000, '777', 'scr:hapoalimBiz:628-1:777:2026-09-15:-5000'),
  ];
  const p = pullTwinPairs(rows);
  assert.equal(p.length, 1);
  assert.equal(p[0].late.id, 2);
  assert.deepEqual(p[0].diff, ['acct']);
});

test('pull twins: a line dated the day the earlier pull ran (could still be pending then) is NOT a twin', () => {
  const rows = [
    PR(1, 10, '2026-09-16 09:00:00', '2026-09-15', -5000, '777', 'scr:x:a:777:2026-09-15:-5000'),
    PR(2, 11, '2026-10-02 09:00:00', '2026-09-15', -5000, '777', 'scr:x:a:778:2026-09-15:-5000'),
  ];
  assert.equal(pullTwinPairs(rows).length, 0, 'the earlier pull may not have seen the second one yet');
});

test('pull twins: two identical lines in the SAME pull are two real transactions', () => {
  const rows = [
    PR(1, 10, '2026-10-02 09:00:00', '2026-09-15', -5000, '777', 'scr:x:a:777:2026-09-15:-5000'),
    PR(2, 10, '2026-10-02 09:00:00', '2026-09-15', -5000, '777', 'scr:x:a:777b:2026-09-15:-5000'),
  ];
  assert.equal(pullTwinPairs(rows).length, 0);
  assert.deepEqual(idDiff('scr:x:a:1:2026-09-15:-5', 'scr:x:a:1:2026-09-16:-5'), ['date']);
});

test('imports table: date range per import and how many of its rows were already there', async () => {
  const a = await cleanAccount(0);
  const imp = async (ranAt) => Number((await db.run(
    "INSERT INTO bank_imports (bank_account_id, source, rows_total, imported_at) VALUES (?, 'scraper', 0, ?)", [a, ranAt],
  )).lastInsertRowid);
  const i1 = await imp('2026-09-28 01:41:00');
  const i2 = await imp('2026-10-02 18:03:00');
  const put = (imp2, date, amount, ref, ext) => db.run(
    "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source, external_id, import_id) VALUES (?, ?, ?, 'x', ?, 'scraper', ?, ?)",
    [a, date, amount, ref, ext, imp2],
  );
  await put(i1, '2026-09-10', -100, '1', 'scr:hapoalimBiz:A:1:2026-09-10:-100');
  await put(i1, '2026-09-11', -200, '2', 'scr:hapoalimBiz:A:2:2026-09-11:-200');
  await put(i2, '2026-09-10', -100, '1', 'scr:hapoalimBiz:B:1:2026-09-10:-100');
  await put(i2, '2026-09-11', -200, '2', 'scr:hapoalimBiz:B:2:2026-09-11:-200');
  await put(i2, '2026-10-01', -300, '3', 'scr:hapoalimBiz:B:3:2026-10-01:-300');
  const { listImports } = await import('../src/services/bankTransactions.js');
  const list = await listImports({ accountId: a }, db);
  const second = list.find((r) => Number(r.id) === i2);
  assert.equal(second.twinsOfEarlier, 2, 'two of its three rows were already there');
  assert.deepEqual(second.range, { from: '2026-09-10', to: '2026-10-01' });
  const d = await findAccountDuplicates(a, db);
  assert.equal(d.pullTwinCount, 2);
  assert.deepEqual(d.pullTwinByDiff, [{ diff: 'acct', n: 2 }]);
});

test('route: the integrity page explains the pull twins (read-only) and the imports table links to it', async () => {
  const a = accts[0]; // left by the previous test: two twins whose ids differ in the account part
  const cookie = `session=${createSession(o.id)}`;
  const page = await (await fetch(`${base}/reconciliation/integrity?account=${a}`, { headers: { cookie } })).text();
  assert.match(page, /1ב\. אותה תנועה בשתי משיכות מהבנק/);
  assert.match(page, /<strong>2<\/strong> תנועות נקלטו פעמיים/);
  assert.match(page, /<strong>חשבון<\/strong> ×2/);
  const rec = await (await fetch(`${base}/reconciliation?account=${a}`, { headers: { cookie } })).text();
  assert.match(rec, /#pull-twins" class="badge b-blocked"[^>]*>2</);
});
