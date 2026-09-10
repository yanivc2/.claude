import test from 'node:test';
import assert from 'node:assert/strict';
import { plainNumber, isOddNumberText } from '../src/lib/numText.js';
import { normalizeBankRows, normalizeReference } from '../src/lib/bankCsv.js';
import { decodeFileName } from '../src/lib/decodeText.js';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import {
  importTransactions,
  listTransactions,
  oddReferences,
  normalizeStoredReferences,
  matchRowsToTransactions,
  listImports,
} from '../src/services/bankTransactions.js';

// היצואן של דף הבנק כותב מספרים כפי ש-Java מדפיסה double. אלה הערכים האמיתיים שהופיעו בעמודת
// "אסמכתא" על המסך.
const REAL = [
  ['1.81732779E8', '181732779'],
  ['26411.0', '26411'],
  ['2.16404166E8', '216404166'],
  ['6.5088884E7', '65088884'],
  ['1.8120068E8', '181200680'],
];

test('כתיב מדעי מורחב לספרות — בדיוק הערכים שהגיעו מהבנק', () => {
  for (const [raw, want] of REAL) assert.equal(plainNumber(raw), want, raw);
});

test('ההרחבה טקסטואלית ולא דרך Number — 16 ספרות שורדות', () => {
  // String(Number('9.007199254740993E15')) מאבד את הספרה האחרונה. אסמכתא בת 16 ספרה היא דבר קיים.
  assert.equal(plainNumber('9.007199254740993E15'), '9007199254740993');
  assert.notEqual(String(Number('9.007199254740993E15')), '9007199254740993');
});

test('מה שאינו מספר בכתיב חריג נשאר כמות שהוא', () => {
  for (const s of ['', 'abc', '12,345', '1234.56', 'צ׳ק 4471', '0012']) {
    assert.equal(plainNumber(s), s, s);
    assert.equal(isOddNumberText(s), false, s);
  }
});

test('שברים ומספרים שליליים נשמרים נכון', () => {
  assert.equal(plainNumber('1.5E-3'), '0.0015');
  assert.equal(plainNumber('-2.5E3'), '-2500');
});

test('normalizeBankRows כותב את האסמכתא בספרות בשני מסלולי הקריאה', () => {
  const bank = normalizeBankRows([
    { 'תאריך': '01/09/2026', 'חובה': '1500.00', 'אסמכתא': '1.81732779E8', 'תיאור': 'שיק' },
  ]);
  assert.equal(bank[0].rawReference, '181732779');

  const simple = normalizeBankRows([
    { date: '2026-09-01', amount: '-15.00', description: 'x', reference: '26411.0' },
  ]);
  assert.equal(simple[0].rawReference, '26411');
});

test('סכום בכתיב מדעי מתפרש נכון ולא נופל', () => {
  const rows = normalizeBankRows([{ 'תאריך': '01/09/2026', 'זכות': '1.5E3', 'אסמכתא': '77' }]);
  assert.equal(rows[0].amount, 150000); // 1500 ₪ באגורות
});

test('normalizeReference אינה נוגעת בטקסט חופשי', () => {
  assert.equal(normalizeReference('שיק 4471'), 'שיק 4471');
  assert.equal(normalizeReference(null), '');
});

test('שם קובץ מקולקל מפוענח, ושם תקין לא נפגע — גם בקריאה חוזרת', () => {
  const good = 'פקדון ספטמבר.csv';
  const moji = Buffer.from(good, 'utf8').toString('latin1');
  assert.equal(decodeFileName(moji), good);
  assert.equal(decodeFileName(good), good);
  assert.equal(decodeFileName(decodeFileName(moji)), good); // אידמפוטנטי
  assert.equal(decodeFileName('sept-2026.csv'), 'sept-2026.csv');
  assert.equal(decodeFileName(''), null);
});

test('אסמכתאות שכבר נשמרו בכתיב מדעי — נספרות, נכתבות בספרות, והפעולה חוזרת בלי נזק', async () => {
  const x = await freshDb();
  const store = await firstStore(x);
  const user = await owner(x);
  const acc = await accountForStore(x, store.id);

  // כתיבה ישירה למסד: כך נראות 507 השורות שכבר קיימות אצל הבעלים.
  for (const [raw] of REAL) {
    await x.run(
      `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
       VALUES (?, ?, ?, ?, ?, 'csv')`,
      [acc.id, '2026-09-01', -1000, 'שיק', raw],
    );
  }
  await x.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, ?, ?, ?, ?, 'csv')`,
    [acc.id, '2026-09-02', -2000, 'עמלה', '4471'],
  );

  const before = await oddReferences(acc.id, x);
  assert.equal(before.count, REAL.length);

  const r = await normalizeStoredReferences(acc.id, user, x);
  assert.equal(r.fixed, REAL.length);

  const after = await listTransactions(acc.id, x);
  const refs = after.map((t) => t.raw_reference).sort();
  assert.deepEqual(refs, [...REAL.map(([, want]) => want), '4471'].sort());

  // חזרה על הפעולה אינה משנה דבר — היא קנונית, לא הרסנית.
  assert.equal((await normalizeStoredReferences(acc.id, user, x)).fixed, 0);
  assert.equal((await oddReferences(acc.id, x)).count, 0);
});

test('העלאה חוזרת של אותו קובץ אינה מכפילה שורות שנשמרו בכתיב מדעי', async () => {
  const x = await freshDb();
  const store = await firstStore(x);
  const user = await owner(x);
  const acc = await accountForStore(x, store.id);

  // שורה ישנה, בכתיב שהיה נשמר לפני התיקון.
  await x.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, ?, ?, ?, ?, 'csv')`,
    [acc.id, '2026-09-01', -150000, 'שיק', '1.81732779E8'],
  );

  // אותו קובץ בדיוק, נקרא עכשיו עם התיקון: האסמכתא נקייה.
  const rows = normalizeBankRows([
    { 'תאריך': '01/09/2026', 'חובה': '1500.00', 'אסמכתא': '1.81732779E8', 'תיאור': 'שיק' },
  ]);
  const res = await importTransactions(acc.id, rows, 'csv', user, x, { fileName: 'a.csv' });
  assert.equal(res.inserted, 0, 'השורה הישנה זוהתה ככפילות ולא הוכפלה');
  assert.equal(res.skipped, 1);
  assert.equal((await listTransactions(acc.id, x)).length, 1);
});

test('ניקוי לפי קובץ מוצא שורה שנשמרה בכתיב מדעי', async () => {
  const x = await freshDb();
  const store = await firstStore(x);
  const acc = await accountForStore(x, store.id);
  await x.run(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, ?, ?, ?, ?, 'csv')`,
    [acc.id, '2026-09-01', -150000, 'שיק', '1.81732779E8'],
  );
  const rows = normalizeBankRows([
    { 'תאריך': '01/09/2026', 'חובה': '1500.00', 'אסמכתא': '181732779', 'תיאור': 'שיק' },
  ]);
  const hit = await matchRowsToTransactions(acc.id, rows, x);
  assert.equal(hit.ids.length, 1, 'שני כתיבים של אותה אסמכתא הם אותה תנועה');
});

test('שם קובץ מקולקל שנשמר במסד מוצג מפוענח ברשימת הייבוא', async () => {
  const x = await freshDb();
  const store = await firstStore(x);
  const user = await owner(x);
  const acc = await accountForStore(x, store.id);
  const good = 'פקדון ספטמבר.csv';
  await importTransactions(
    acc.id,
    [{ txnDate: '2026-09-01', amount: -100, description: 'x', rawReference: '1' }],
    'csv', user, x,
    { fileName: Buffer.from(good, 'utf8').toString('latin1') },  // כפי ש-multer מסר אותו פעם
  );
  const imps = await listImports({ accountId: acc.id }, x);
  assert.equal(imps[0].file_name, good);
});
