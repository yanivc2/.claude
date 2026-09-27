// 🔴 המקרה שנמצא לפני הקליטה החיה הראשונה: עד היום התנועות נכנסו מקבצי Excel של הבנק (בלי מזהה
// בנק), והסוכן מושך 60 יום אחורה עם מזהה משלו. בדיקת כפילות לפי מזהה בלבד לא ראתה את שורות
// הקובץ — וכל החפיפה הייתה נקלטת פעמיים. בנוסף: רק החשבונות הרשומים באפליקציה נקראים מהבנק.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner, firstStore } from './helpers.js';
import { importTransactions } from '../src/services/bankTransactions.js';
import { pickKnownAccounts } from '../src/scraper/hapoalimBiz.js';
import { requestSync, claimNext } from '../src/services/bankSyncJobs.js';

async function account(db) {
  const st = await firstStore(db);
  return (await db.one('SELECT id FROM bank_accounts WHERE store_id = ?', [st.id])).id;
}
const count = async (db, acct) => (await db.one('SELECT COUNT(*) AS n FROM bank_transactions WHERE bank_account_id = ?', [acct])).n;

test('שורת בנק שכבר נקלטה מקובץ Excel אינה נקלטת שוב — גם בניסוח ובתאריך אחרים', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await account(db);
  // מהקובץ: תאריך ערך, ניסוח של הקובץ
  await importTransactions(acct, [
    { txnDate: '2026-09-01', amount: -50000, description: 'שיק 5001', rawReference: '5001' },
    { txnDate: '2026-09-02', amount: 120000, description: 'הפקדת מזומן' },
    { txnDate: '2026-09-03', amount: -1290, description: 'עמלה' },
  ], 'csv', o, db);
  // מהבנק: תאריך פעולה (יום לפני), ניסוח של האתר, ועוד תנועה אחת חדשה
  const r = await importTransactions(acct, [
    { txnDate: '2026-08-31', amount: -50000, description: 'צ׳ק', rawReference: '5001', externalId: 'scr:b:1:5001:2026-08-31:-50000' },
    { txnDate: '2026-09-02', amount: 120000, description: 'הפקדה — סניף', rawReference: '77', externalId: 'scr:b:1:77:2026-09-02:120000' },
    { txnDate: '2026-09-03', amount: -1290, description: 'עמלת ניהול', rawReference: '9', externalId: 'scr:b:1:9:2026-09-03:-1290' },
    { txnDate: '2026-09-05', amount: -30000, description: 'העברה', rawReference: '88', externalId: 'scr:b:1:88:2026-09-05:-30000' },
  ], 'scraper', o, db);
  assert.equal(r.inserted, 1, 'רק התנועה החדשה');
  assert.equal(r.adopted, 3);
  assert.equal(await count(db, acct), 4);
  // השורה מהקובץ קיבלה את מזהה הבנק — משיכה חוזרת מזהה אותה ישירות
  const chk = await db.one('SELECT external_id, description FROM bank_transactions WHERE bank_account_id = ? AND raw_reference = ?', [acct, '5001']);
  assert.equal(chk.external_id, 'scr:b:1:5001:2026-08-31:-50000');
  assert.equal(chk.description, 'שיק 5001', 'השורה המקורית נשארת כמו שהיא');
  const again = await importTransactions(acct, [
    { txnDate: '2026-08-31', amount: -50000, description: 'צ׳ק', rawReference: '5001', externalId: 'scr:b:1:5001:2026-08-31:-50000' },
    { txnDate: '2026-09-05', amount: -30000, description: 'העברה', rawReference: '88', externalId: 'scr:b:1:88:2026-09-05:-30000' },
  ], 'scraper', o, db);
  assert.equal(again.inserted, 0);
  assert.equal(await count(db, acct), 4);
});

test('עמלה קבועה שחוזרת כל יום: כל שורה ישנה נתפסת פעם אחת, ושורת היום החדשה נקלטת', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await account(db);
  await importTransactions(acct, [
    { txnDate: '2026-09-01', amount: -1290, description: 'עמלה' },
    { txnDate: '2026-09-02', amount: -1290, description: 'עמלה' },
  ], 'csv', o, db);
  const r = await importTransactions(acct, [
    { txnDate: '2026-09-01', amount: -1290, description: 'עמלת ניהול', rawReference: '1', externalId: 'e1' },
    { txnDate: '2026-09-02', amount: -1290, description: 'עמלת ניהול', rawReference: '2', externalId: 'e2' },
    { txnDate: '2026-09-03', amount: -1290, description: 'עמלת ניהול', rawReference: '3', externalId: 'e3' },
  ], 'scraper', o, db);
  assert.equal(r.adopted, 2);
  assert.equal(r.inserted, 1);
  assert.equal(await count(db, acct), 3);
});

test('סכום זהה במרחק של יותר מ-3 ימים הוא תנועה אחרת', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await account(db);
  await importTransactions(acct, [{ txnDate: '2026-09-01', amount: -9900, description: 'מנוי' }], 'csv', o, db);
  const r = await importTransactions(acct, [
    { txnDate: '2026-09-10', amount: -9900, description: 'מנוי', rawReference: '5', externalId: 'x5' },
  ], 'scraper', o, db);
  assert.equal(r.inserted, 1);
  assert.equal(r.adopted, 0);
});

test('ייבוא קובץ (בלי מזהה) ממשיך לזהות כפילות לפי שדות, גם בתוך אותו קובץ', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await account(db);
  const rows = [{ txnDate: '2026-09-01', amount: -100, description: 'א', rawReference: '1' }];
  assert.equal((await importTransactions(acct, [...rows, ...rows], 'csv', o, db)).inserted, 1);
  assert.equal((await importTransactions(acct, rows, 'csv', o, db)).inserted, 0);
});

test('רק החשבונות הרשומים באפליקציה נקראים מהבנק', () => {
  const inApp = [{ branch: '628', account_number: '432110' }, { branch: '531', account_number: '778899' }];
  const atBank = ['12-628-432110', '12-531-778899', '12-628-111111', '12-600-222222'];
  assert.deepEqual(pickKnownAccounts(atBank, inApp), ['12-628-432110', '12-531-778899']);
  assert.deepEqual(pickKnownAccounts(atBank, []), []);
});

test('הבקשה שהסוכן תופס נושאת את רשימת החשבונות הרשומים — ספרות בלבד', async () => {
  const db = await freshDb();
  const o = await owner(db);
  await requestSync(o, db);
  const job = await claimNext('office', db);
  const n = (await db.one('SELECT COUNT(*) AS n FROM bank_accounts', [])).n;
  assert.equal(job.accounts.length, n);
  for (const a of job.accounts) {
    assert.deepEqual(Object.keys(a).sort(), ['account_number', 'branch']);
    assert.match(a.account_number, /^\d+$/);
  }
});

test('שורה שנסרקה בפורמט המזהה הישן מזוהה גם מול המזהה החדש', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const acct = await account(db);
  await importTransactions(acct, [
    { txnDate: '2026-09-01', amount: -50000, description: 'צ׳ק', rawReference: '5001', externalId: 'scr:hapoalimBiz:12-628-432110:5001' },
  ], 'scraper', o, db);
  const r = await importTransactions(acct, [
    { txnDate: '2026-09-01', amount: -50000, description: 'צ׳ק', rawReference: '5001', externalId: 'scr:hapoalimBiz:12-628-432110:5001:2026-09-01:-50000' },
  ], 'scraper', o, db);
  assert.equal(r.inserted, 0);
  assert.equal(await count(db, acct), 1);
});

// 🔴 תנועה מותאמת להפקדה (deposits.matched_txn_id, FK). ביטול ייבוא ששחרר רק צ׳קים נפל ב-Postgres
// על ה-FK — אחרי שהצ׳קים כבר שוחררו. עכשיו: נספר באישור, משוחרר, ונמחק.
test('ביטול ייבוא משחרר גם התאמה להפקדה, ולא נופל על ה-FK', async () => {
  const { deleteImport } = await import('../src/services/bankTransactions.js');
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const acct = await account(db);
  const imp = await importTransactions(acct, [
    { txnDate: '2026-09-02', amount: 120000, description: 'הפקדה', rawReference: '77', externalId: 'd77' },
  ], 'scraper', o, db);
  const txn = await db.one('SELECT id FROM bank_transactions WHERE bank_account_id = ? AND external_id = ?', [acct, 'd77']);
  const dep = await db.run(
    'INSERT INTO deposits (store_id, deposit_date, amount, deposited, matched_txn_id, created_by) VALUES (?, ?, ?, 1, ?, ?)',
    [st.id, '2026-09-02', 120000, txn.id, o.id],
  );
  await assert.rejects(() => deleteImport(imp.importId, o, {}, db), /הפקדות/);
  const r = await deleteImport(imp.importId, o, { releaseMatched: true }, db);
  assert.equal(r.deleted, 1);
  assert.equal(r.released, 1);
  const d = await db.one('SELECT matched_txn_id, deposited FROM deposits WHERE id = ?', [dep.lastInsertRowid]);
  assert.equal(d.matched_txn_id, null);
  assert.equal(Number(d.deposited), 1, 'הכסף אכן הופקד — רק ההתאמה משתחררת');
});
