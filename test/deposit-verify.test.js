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
  // הטבלה עברה לפרשל משותף — לוח הבקרה ומרקורים מציגים את **אותה** טבלה.
  const v = readFileSync(new URL('../src/views/partials/_deposits.ejs', import.meta.url), 'utf8');
  assert.match(v, /<th>סטטוס<\/th><th>תאריך סטטוס<\/th>[\s\S]{0,80}<th>אימות ספירה<\/th><th>תאריך אימות<\/th>/,
    '"תאריך סטטוס" יושב משמאל לסטטוס (כלומר אחריו ב-DOM, בכיוון RTL)');
  assert.match(v, /correctionTotal > 0[\s\S]{0,120}var\(--color-ok\)/, 'פלוס בירוק');
  assert.match(v, /correctionTotal < 0[\s\S]{0,140}var\(--color-bad\)/, 'מינוס באדום');
  assert.match(v, /−<%= formatIls\(-v\.correctionTotal\)/, 'מינוס מוצג עם סימן');
  assert.equal(VERIFY_WINDOW_DAYS, 7);
});

// ── שתי שקיות בשדה אחד, ו"יתרה / חוסר" שתואם לדוח ה-Z ──────────────────────────
import { bagReferences, depositZDiffs } from '../src/services/deposits.js';
import { reconcileDeposits } from '../src/services/reconciliation.js';
import { depositDiff } from '../src/services/zreports.js';

test('שדה שקית אחד יכול לשאת כמה מספרים', () => {
  assert.deepEqual(bagReferences('216404173+216404174'), ['216404173', '216404174']);
  assert.deepEqual(bagReferences('216404173'), ['216404173']);
  assert.deepEqual(bagReferences('111, 222 / 333'), ['111', '222', '333']);
  assert.deepEqual(bagReferences('1.6E8'), ['160000000'], 'כתיב מדעי מורחב לפני הפיצול');
  assert.deepEqual(bagReferences(''), []);
});

test('🔴 הפקדה של שתי שקיות מותאמת לשתי שורות הבנק — ומקבלת תאריך סטטוס', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  const put = async (date, amount, ref) => (await x.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, ?, ?, 'הפ.תיק ממסרים', ?, 'csv')`, [acc.id, date, amount, ref])).lastInsertRowid;
  await put('2026-09-05', 6823000, '216404173');
  await put('2026-09-05', 6638500, '216404174');
  const dep = await x.run(
    `INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, created_by)
     VALUES (?, '2026-09-05', '216404173+216404174', 13461500, 0, ?)`, [store.id, ow.id]);

  const r = await reconcileDeposits(acc.id, ow, x);
  assert.equal(r.matched, 1, 'שדה עם "+" חייב להתאים — קודם הוא לא התאים לאף שורה');
  const row = await x.one('SELECT * FROM deposits WHERE id = ?', [dep.lastInsertRowid]);
  assert.ok(row.matched_txn_id, 'בלי זה אין תאריך סטטוס ואין אימות ספירה');
  assert.equal(row.recon_diff, 0, 'שתי השקיות יחד מול הסכום שהוצהר');
  assert.equal(row.deposited, 1);

  const v = (await depositVerifications(await listDeposits({ scope: null }, x), x)).get(Number(dep.lastInsertRowid));
  assert.equal(v.statusDate, '2026-09-05');
});

test('🔴 תיקון על שתי השקיות נספר במלואו', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  const put = async (date, amount, ref) => x.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, ?, ?, 'x', ?, 'csv')`, [acc.id, date, amount, ref]);
  await put('2026-09-05', 6823000, '216404173');
  await put('2026-09-05', 6638500, '216404174');
  const dep = await x.run(
    `INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, created_by)
     VALUES (?, '2026-09-05', '216404173+216404174', 13461500, 0, ?)`, [store.id, ow.id]);
  await reconcileDeposits(acc.id, ow, x);
  // כל שקית נספרה מחדש בסניף: −10 באחת, −5 בשנייה
  await put('2026-09-07', -6823000, '216404173'); await put('2026-09-07', 6822000, '216404173');
  await put('2026-09-08', -6638500, '216404174'); await put('2026-09-08', 6638000, '216404174');

  const v = (await depositVerifications(await listDeposits({ scope: null }, x), x)).get(Number(dep.lastInsertRowid));
  assert.equal(v.correctionTotal, -1500, '₪10 + ₪5 חסרים — משתי השקיות, לא מאחת');
  assert.equal(v.verifyDate, '2026-09-08', 'התאריך של התיקון האחרון');
});

test('🔴 "יתרה / חוסר" בטבלה = אותו מספר שדוח ה-Z מציג', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x);
  const z = await x.run(`INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, created_by)
                         VALUES (?, '2143', '2026-09-05', 0, 13480920, ?)`, [store.id, ow.id]);
  await x.run(`INSERT INTO z_expenses (z_report_id, expense_date, payer_name, purpose, description_type, amount)
               VALUES (?, '2026-09-05', 'נופר', 'ציוד', 'manual', 10000)`, [z.lastInsertRowid]);
  const dep = await x.run(
    `INSERT INTO deposits (store_id, z_report_id, deposit_date, bag_number, amount, deposited, created_by)
     VALUES (?, ?, '2026-09-05', '216404173+216404174', 13461500, 1, ?)`, [store.id, z.lastInsertRowid, ow.id]);

  const rows = await listDeposits({ scope: null }, x);
  const got = (await depositZDiffs(rows, x)).get(Number(dep.lastInsertRowid));
  // 134,809.20 − 100 הוצאות = 134,709.20 אמור לשקית; הופקדו 134,615 → חוסר ₪94.20
  const expected = depositDiff({ drawer_cash: 13480920 }, 10000, 13461500);
  assert.equal(got, expected, 'העמודה חייבת לומר בדיוק את מה שהטופס אומר');
  assert.equal(got, -9420);
});

test('שתי שקיות של אותו Z מציגות הפרש אחד — הפרש של ה-Z, לא של שקית', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x);
  const z = await x.run(`INSERT INTO z_reports (store_id, z_number, z_date, daily_total, drawer_cash, created_by)
                         VALUES (?, '2144', '2026-09-06', 0, 100000, ?)`, [store.id, ow.id]);
  const a = await x.run(`INSERT INTO deposits (store_id, z_report_id, deposit_date, bag_number, amount, created_by)
                         VALUES (?, ?, '2026-09-06', '111', 60000, ?)`, [store.id, z.lastInsertRowid, ow.id]);
  const b = await x.run(`INSERT INTO deposits (store_id, z_report_id, deposit_date, bag_number, amount, created_by)
                         VALUES (?, ?, '2026-09-06', '222', 30000, ?)`, [store.id, z.lastInsertRowid, ow.id]);
  const m = await depositZDiffs(await listDeposits({ scope: null }, x), x);
  // 1,000 בקופה, הופקדו 600+300=900 → חוסר ₪100 על ה-Z כולו
  assert.equal(m.get(Number(a.lastInsertRowid)), -10000);
  assert.equal(m.get(Number(b.lastInsertRowid)), -10000, 'אותו הפרש — זה הפרש אחד של ה-Z');
});

test('שני הדפים מציגים את אותה טבלה', () => {
  for (const page of ['dashboard', 'payments/index']) {
    const t = readFileSync(new URL(`../src/views/${page}.ejs`, import.meta.url), 'utf8');
    assert.match(t, /_deposits/, `${page}: אותו פרשל`);
  }
  const partial = readFileSync(new URL('../src/views/partials/_deposits.ejs', import.meta.url), 'utf8');
  for (const col of ['מספר שקית', 'יתרה / חוסר', 'סטטוס', 'תאריך סטטוס', 'אימות ספירה', 'תאריך אימות']) {
    assert.ok(partial.includes(col), col);
  }
});

test('🔴 שורת "תיקון" אינה נספרת כחלק מההפקדה', async () => {
  // נמדד: כשדף הבנק שיובא כבר מכיל את התיקונים, לקיחת כל השורות החיוביות באותה אסמכתה ספרה
  // גם את הזיכוי-מחדש, ו-recon_diff יצא בגובה הפקדה שלמה (+68,220 במקום 0).
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  const put = async (date, amount, ref) => x.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, ?, ?, 'x', ?, 'csv')`, [acc.id, date, amount, ref]);
  await put('2026-09-05', 6823000, '216404173');
  await put('2026-09-05', 6638500, '216404174');
  await put('2026-09-07', -6823000, '216404173');   // ביטול
  await put('2026-09-07', 6822000, '216404173');    // זיכוי מחדש
  const dep = await x.run(
    `INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, created_by)
     VALUES (?, '2026-09-05', '216404173+216404174', 13461500, 0, ?)`, [store.id, ow.id]);

  await reconcileDeposits(acc.id, ow, x);
  const row = await x.one('SELECT * FROM deposits WHERE id = ?', [dep.lastInsertRowid]);
  assert.equal(row.recon_diff, 0, 'רק שורת הזיכוי הראשונה לכל שקית');
  const v = (await depositVerifications(await listDeposits({ scope: null }, x), x)).get(Number(dep.lastInsertRowid));
  assert.equal(v.correctionTotal, -1000, 'התיקון נספר בעמודה שלו, ולא פעמיים');
});

test('🔴 "הופקדה" הוא סימון ידני — רק "הותאמה בבנק" אומר שהבנק ראה את הכסף', async () => {
  // הבאדג' הדו-מצבי הציג "הופקד" ירוק מול תאריך סטטוס ריק: סתירה שנראית כמו תקלת תצוגה, בזמן
  // שהמצב האמיתי הוא "אמרתי שהפקדתי, הבנק עוד לא אישר".
  const { depositStatus } = await import('../src/services/deposits.js');
  assert.equal(depositStatus({ deposited: 0 }).label, 'הונפקה');
  assert.equal(depositStatus({ deposited: 1 }).label, 'הופקדה');
  assert.equal(depositStatus({ deposited: 1, matched_txn_id: 5 }).label, 'הותאמה בבנק');

  const partial = readFileSync(new URL('../src/views/partials/_deposits.ejs', import.meta.url), 'utf8');
  assert.match(partial, /depositStatus\(d\)/, 'הטבלה משתמשת בשלושת המצבים ולא בבדיקת deposited לבדה');
  assert.match(partial, /טרם אותרה בבנק/, 'סימון ידני אומר במפורש שהבנק עוד לא אישר');
  assert.ok(!/badge b-approved">הופקד</.test(partial), 'הבאדג\' הדו-מצבי הוסר');
});
