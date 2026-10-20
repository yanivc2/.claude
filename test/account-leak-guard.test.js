// בעלים 21/10: "תדאג שזה לא יקרה שוב — שלא תהיה זליגה בין החשבונות, זה חוק ברזל" + "הזנב עד 30/9 —
// אפשר למחוק בבטחה?". צ׳קים של פינק ושל על הדרך נכנסו למידנייט מקובץ ישן, ושניים מהם סגרו צ׳קים של
// מידנייט לפי סכום; ושרשרת ₪1,187 (31606→31919→32151→32537) סימנה צ׳ק שלא נפרע כ"נפרע".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, secretary, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import {
  importTransactions, foreignRowsFor, setUnmatchedHiddenUntil, tailCleanupPreview, tailCleanup, bankPurgedUntil,
} from '../src/services/bankTransactions.js';
import { confirmMatch, rematchByNumber, mismatchedMatchesFor } from '../src/services/reconciliation.js';
import { RuleError } from '../src/lib/errors.js';

let db, o, sec, A, B, server, base;
const pay = (acc, num, amount, date) => db.run(
  "INSERT INTO payments (bank_account_id, method, check_number, payment_date, amount, status, created_by) VALUES (?, 'check', ?, ?, ?, 'issued', ?)",
  [acc.id, num, date, amount, o.id],
);
const statusOf = async (id) => (await db.one('SELECT status, cleared_date FROM payments WHERE id = ?', [id]));

before(async () => {
  db = await freshDb();
  o = await owner(db);
  sec = await secretary(db);
  A = await accountForStore(db, 1);
  B = await accountForStore(db, 3);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('a file row that the bank already lists in ANOTHER account is not imported; fee codes are not evidence', async () => {
  // הבנק (המשיכה) מציג את צ׳ק 18338 בפינק, ואת העמלה 1001 בשני החשבונות.
  await importTransactions(B.id, [
    { txnDate: '2026-08-26', amount: -161600, description: 'שיק', rawReference: '18338', externalId: 'scr:t:B:18338:2026-08-26:-161600' },
    { txnDate: '2026-09-01', amount: -900, description: 'עמ׳ ONTIME', rawReference: '1001', externalId: 'scr:t:B:1001:2026-09-01:-900' },
  ], 'scraper', o, db);
  const r = await importTransactions(A.id, [
    { txnDate: '2026-08-26', amount: -161600, description: 'שיק', rawReference: '0018338' }, // של פינק
    { txnDate: '2026-08-27', amount: -50000, description: 'שיק', rawReference: '31700' },   // של מידנייט
    { txnDate: '2026-09-01', amount: -900, description: 'עמ׳ ONTIME', rawReference: '1001' }, // עמלה — שלו
  ], 'csv', sec, db, { fileName: 'mixed.xlsx' });
  assert.equal(r.inserted, 2);
  assert.deepEqual(r.foreign.map((f) => [f.ref, f.account]), [['0018338', B.display_name]]);
  assert.ok(!(await db.one("SELECT id FROM bank_transactions WHERE bank_account_id = ? AND raw_reference = '0018338'", [A.id])));
});

test('a file that is MOSTLY another account is refused whole — nothing is written, not even the import record', async () => {
  await importTransactions(B.id, [
    { txnDate: '2026-09-06', amount: -31200, description: 'שיק', rawReference: '18477', externalId: 'scr:t:B:18477' },
    { txnDate: '2026-09-07', amount: -40000, description: 'שיק', rawReference: '18478', externalId: 'scr:t:B:18478' },
  ], 'scraper', o, db);
  const imports = (await db.one('SELECT COUNT(*) AS n FROM bank_imports', [])).n;
  await assert.rejects(
    importTransactions(A.id, [
      { txnDate: '2026-09-06', amount: -31200, description: 'שיק', rawReference: '18477' },
      { txnDate: '2026-09-07', amount: -40000, description: 'שיק', rawReference: '18478' },
      { txnDate: '2026-09-08', amount: -10000, description: 'שיק', rawReference: '31800' },
    ], 'csv', sec, db),
    (e) => e instanceof RuleError && /הקובץ שייך כנראה לחשבון/.test(e.message) && e.message.includes(B.display_name),
  );
  assert.equal(Number((await db.one('SELECT COUNT(*) AS n FROM bank_imports', [])).n), Number(imports));
});

test('a debit whose number is a check issued from another account (same amount) is foreign — unless this account issued that number too', async () => {
  await pay(B, '27463', 230700, '2026-08-22');
  const f = await foreignRowsFor(A.id, [{ txnDate: '2026-08-23', amount: -230700, rawReference: '27463' }], db);
  assert.equal(f.length, 1);
  await pay(A, '27463', 99900, '2026-08-01');
  assert.equal((await foreignRowsFor(A.id, [{ txnDate: '2026-08-23', amount: -230700, rawReference: '27463' }], db)).length, 0, 'the number is in this checkbook too — not evidence');
});

test('the bank pull is never blocked — it comes per account from the bank itself', async () => {
  const r = await importTransactions(A.id, [{ txnDate: '2026-08-26', amount: -161600, description: 'שיק', rawReference: '18338', externalId: 'scr:t:A:x' }], 'scraper', o, db);
  assert.equal(r.inserted, 1);
  assert.equal(r.foreign.length, 0);
  await db.run("DELETE FROM bank_transactions WHERE external_id = 'scr:t:A:x'", []);
});

test('manual add of a row listed in another account is refused with the account name', async () => {
  const res = await fetch(`${base}/reconciliation/add`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `session=${createSession(o.id)}; ap_store=1`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account_id: String(A.id), txn_date: '2026-08-26', amount: '-1616', reference: '18338', description: 'שיק' }),
  });
  assert.equal(res.status, 303);
  const err = new URL(res.headers.get('location'), base).searchParams.get('err');
  assert.match(err, /התנועה לא נוספה: אסמכתא 18338/);
  assert.ok(err.includes(B.display_name));
});

test('rematch: an amount-only chain is undone and rebuilt by number; the last check goes back to outstanding', async () => {
  // 31606 לא הוזן; 31919, 32151, 32537 הוזנו — כל אחד ₪1,187.
  const p1 = (await pay(A, '31919', 118700, '2026-07-30')).lastInsertRowid;
  const p2 = (await pay(A, '32151', 118700, '2026-09-10')).lastInsertRowid;
  const p3 = (await pay(A, '32537', 118700, '2026-10-05')).lastInsertRowid;
  await importTransactions(A.id, [
    { txnDate: '2026-08-06', amount: -118700, description: 'שיק', rawReference: '31606', externalId: 'scr:t:A:31606' },
    { txnDate: '2026-09-22', amount: -118700, description: 'שיק', rawReference: '31919', externalId: 'scr:t:A:31919' },
    { txnDate: '2026-10-11', amount: -118700, description: 'שיק', rawReference: '32151', externalId: 'scr:t:A:32151' },
  ], 'scraper', o, db);
  const id = async (ref) => (await db.one('SELECT id FROM bank_transactions WHERE bank_account_id = ? AND raw_reference = ?', [A.id, ref])).id;
  await confirmMatch(await id('31606'), p1, o, db); // מה שההתאמה הישנה עשתה
  await confirmMatch(await id('31919'), p2, o, db);
  await confirmMatch(await id('32151'), p3, o, db);
  assert.equal((await mismatchedMatchesFor(A.id, db)).length, 3);

  const r = await rematchByNumber(A.id, o, db);
  assert.equal(r.undone, 3);
  assert.equal((await mismatchedMatchesFor(A.id, db)).length, 0);
  assert.deepEqual(await statusOf(p1), { status: 'cleared', cleared_date: '2026-09-22' });
  assert.deepEqual(await statusOf(p2), { status: 'cleared', cleared_date: '2026-10-11' });
  assert.equal((await statusOf(p3)).status, 'issued', '32537 was never cashed — back to outstanding');
  assert.ok(!(await db.one('SELECT matched_payment_id FROM bank_transactions WHERE id = ?', [await id('31606')])).matched_payment_id, '31606 is unexplained now');
});

test('tail cleanup: only rows nothing leans on are deleted, a row that can still close an open check stays, and the pull does not bring them back', async () => {
  await setUnmatchedHiddenUntil('2026-09-30', o, db);
  await pay(A, '31650', 77700, '2026-08-01'); // צ׳ק פתוח — השורה שלו (מלפני התאריך) חייבת להישאר
  await importTransactions(A.id, [
    { txnDate: '2026-08-10', amount: -77700, description: 'שיק', rawReference: '31650', externalId: 'scr:t:A:31650' },
    { txnDate: '2026-08-11', amount: -1234, description: 'עמלה', rawReference: '', externalId: 'scr:t:A:fee' },
  ], 'scraper', o, db);
  const p = await tailCleanupPreview(A.id, db);
  const del = p.toDelete.map((r) => r.raw_reference || r.description);
  assert.ok(del.includes('31606') && del.includes('עמלה'), 'unexplained rows go');
  assert.ok(!del.includes('31919') && !del.includes('32151'), 'matched rows stay');
  assert.deepEqual(p.keptOpen.map((r) => r.raw_reference), ['31650'], 'a row that can still close an open check stays');

  const r = await tailCleanup(A.id, o, db);
  assert.equal(r.deleted, p.toDelete.length);
  assert.equal(await bankPurgedUntil(db), '2026-09-30');
  // המשיכה הבאה מחזירה 60 יום — השורות שנמחקו לא חוזרות; שורה חדשה אחרי התאריך נקלטת.
  const again = await importTransactions(A.id, [
    { txnDate: '2026-08-06', amount: -118700, description: 'שיק', rawReference: '31606', externalId: 'scr:t:A:31606' },
    { txnDate: '2026-10-15', amount: -5000, description: 'שיק', rawReference: '32600', externalId: 'scr:t:A:32600' },
  ], 'scraper', o, db);
  assert.equal(again.inserted, 1);
  assert.equal(again.skippedOld, 1);
});

test('tail cleanup refuses while amount-only matches remain (they must be fixed first)', async () => {
  const pX = (await pay(A, '33001', 55500, '2026-09-01')).lastInsertRowid;
  await importTransactions(A.id, [{ txnDate: '2026-10-02', amount: -55500, description: 'שיק', rawReference: '33999', externalId: 'scr:t:A:33999' }], 'scraper', o, db);
  const t = await db.one("SELECT id FROM bank_transactions WHERE raw_reference = '33999'", []);
  await confirmMatch(t.id, pX, o, db);
  await assert.rejects(tailCleanup(A.id, o, db), /התאמות לפי סכום בלבד/);
  await rematchByNumber(A.id, o, db);
});

test('UI: "פעולות" in the top bar for the owner only; auto-match moves under the "התאמה" column; the cleanup preview renders', async () => {
  const page = async (u, path = `/reconciliation?account=${A.id}`) => (await fetch(base + path, { headers: { cookie: `session=${createSession(u.id)}; ap_store=1` } })).text();
  const ownerHtml = await page(o);
  assert.match(ownerHtml, /<details class="menu open-in store-banner-quick top-recon-menu no-print">/);
  assert.match(ownerHtml, /href="\/reconciliation\/tail-cleanup\?account=\d+">🧹 מחיקת תנועות עד 30\/09\/26…/);
  assert.doesNotMatch(await page(sec), /top-recon-menu/, 'the secretary has no owner actions');
  assert.match(ownerHtml, /<th data-nosort data-nofilter data-filter-slot="autoMatchForm">התאמה<\/th>/);
  assert.match(ownerHtml, /<form method="post" action="\/reconciliation\/auto" id="autoMatchForm" class="auto-match-form"/);
  const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /th\.getAttribute\('data-filter-slot'\) && document\.getElementById/);
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /main\.page \.btn-auto-match \{\s*background: #ffc940; color: #111; font-weight: 800;/);
  assert.match(css, /main\.page table\.imports-tbl \{ width: 100%; \}/);
  const prev = await page(o, `/reconciliation/tail-cleanup?account=${A.id}`);
  assert.match(prev, /מחיקת תנועות שלפני תחילת העבודה/);
  const secRes = await fetch(`${base}/reconciliation/tail-cleanup?account=${A.id}`, { headers: { cookie: `session=${createSession(sec.id)}; ap_store=1` }, redirect: 'manual' });
  assert.notEqual(secRes.status, 200, 'owner only');
});
