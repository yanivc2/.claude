import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { listDeposits, depositVerifications, VERIFY_WINDOW_DAYS } from '../src/services/deposits.js';

// המקרה האמיתי מדף הבנק: השקית הופקדה ב-14/09 והחשבון זוכה ב-68,230 כפי שהוצהר. למחרת הסניף
// ספר אותה וכתב שתי שורות "תיקון" באותה אסמכתה — ביטול הזיכוי (−68,230) וזיכוי מחדש (+68,220).
// ההפרש הנקי הוא −10, וזה מה שהעמודה צריכה לומר.
const REF = '216404173';

async function setup(x, ow, store, acc) {
  const put = async (date, amount, desc, ref = REF) => (await x.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, ?, ?, ?, ?, 'csv')`, [acc.id, date, amount, desc, ref])).lastInsertRowid;
  const credit = await put('2026-09-14', 6823000, "הפ'.תיק ממסרים");
  const dep = await x.run(
    `INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, matched_txn_id, created_by)
     VALUES (?, '2026-09-14', ?, 6823000, 1, ?, ?)`, [store.id, REF, credit, ow.id]);
  return { put, credit, depId: Number(dep.lastInsertRowid) };
}
const vOf = async (x, depId) => (await depositVerifications(await listDeposits({ scope: null }, x), x)).get(depId);

test('תאריך הסטטוס הוא היום שבו ההפקדה הופיעה בבנק, לא יום ההצהרה', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  const { depId } = await setup(x, ow, store, acc);
  assert.equal((await vOf(x, depId)).statusDate, '2026-09-14');
});

test('🔴 סכום התיקון = סכום שורות התיקון (−68,230 + 68,220 = −10)', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  const { put, depId } = await setup(x, ow, store, acc);
  await put('2026-09-15', -6823000, 'תיקון — ספירה שונה מהפקדה');
  await put('2026-09-15', 6822000, 'תיקון — ספירה שונה מהפקדה');

  const v = await vOf(x, depId);
  assert.equal(v.state, 'corrected');
  assert.equal(v.correctionTotal, -1000, '₪10 חסרים');
  assert.equal(v.verifyDate, '2026-09-15');
  assert.equal(v.corrections.length, 2, 'הזיכוי המקורי אינו נספר כתיקון');
});

test('תיקון בפלוס — הסניף ספר יותר ממה שהוצהר', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  const { put, depId } = await setup(x, ow, store, acc);
  await put('2026-09-16', -6823000, 'תיקון');
  await put('2026-09-16', 6825000, 'תיקון');
  const v = await vOf(x, depId);
  assert.equal(v.correctionTotal, 2000, '₪20 עודף');
});

test('🔴 "אומתה" רק כשדף הבנק מכסה שבוע קדימה — אחרת "ממתין"', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  const { depId } = await setup(x, ow, store, acc);

  // אין עדיין נתונים מעבר ליום ההפקדה: לא ראינו תיקון, אבל גם לא יכולנו לראות.
  let v = await vOf(x, depId);
  assert.equal(v.state, 'waiting', 'אישור שקרי על כסף הוא גרוע מ"עוד לא ידוע"');
  assert.equal(v.deadline, '2026-09-21');

  // עכשיו יש תנועה מאוחרת יותר — החלון מכוסה ולא הגיע תיקון.
  await x.run(`INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, source)
               VALUES (?, '2026-09-25', -100, 'עמלה', 'csv')`, [acc.id]);
  v = await vOf(x, depId);
  assert.equal(v.state, 'verified');
  assert.equal(v.correctionTotal, null);
});

test('אסמכתה של הפקדה אחרת אינה נספרת כתיקון', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  const { put, depId } = await setup(x, ow, store, acc);
  await put('2026-09-15', -5000000, 'תיקון של הפקדה אחרת', '999999999');
  const v = await vOf(x, depId);
  assert.equal(v.corrections.length, 0);
  assert.equal(v.correctionTotal, null);
});

test('הפקדה שעדיין לא הותאמה לבנק אינה מקבלת אימות כלל', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x);
  await x.run(`INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, created_by)
               VALUES (?, '2026-09-14', '777', 100000, 0, ?)`, [store.id, ow.id]);
  const rows = await listDeposits({ scope: null }, x);
  assert.equal((await depositVerifications(rows, x)).size, 0);
});

test('הטבלה מציגה את שלוש העמודות, ואת סימן התיקון בצבע', () => {
  const v = readFileSync(new URL('../src/views/payments/index.ejs', import.meta.url), 'utf8');
  assert.match(v, /<th>סטטוס<\/th><th>תאריך סטטוס<\/th><th>אימות ספירה<\/th><th>תאריך אימות<\/th>/,
    '"תאריך סטטוס" יושב משמאל לסטטוס (כלומר אחריו ב-DOM, בכיוון RTL)');
  assert.match(v, /correctionTotal > 0[\s\S]{0,120}var\(--color-ok\)/, 'פלוס בירוק');
  assert.match(v, /correctionTotal < 0[\s\S]{0,140}var\(--color-bad\)/, 'מינוס באדום');
  assert.match(v, /−<%= formatIls\(-v\.correctionTotal\)/, 'מינוס מוצג עם סימן');
  assert.equal(VERIFY_WINDOW_DAYS, 7);
});
