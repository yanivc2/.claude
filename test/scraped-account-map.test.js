// שיוך חשבון שנסרק לחשבון הרשום באפליקציה.
// 🔴 נמצא לפני ההרצה הראשונה: ייבוא CSV ו-Financy מוסרים מספר חשבון בלבד ("432110"), אבל
// סקרייפר של בנק מוסר "בנק-סניף-חשבון" ("12-628-432110") — כי זה מה שה-API של הבנק דורש.
// ההשוואה הישנה הסירה תווים שאינם ספרות משני הצדדים והשוותה "12628432110" מול "432110":
// כל חשבון שנסרק היה חוזר "לא מזוהה" ואף תנועה לא הייתה נקלטת.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScrapedAccount } from '../src/services/bankSync.js';

const rows = [
  { id: 1, branch: '628', account_number: '432110', display_name: 'מידנייט' },
  { id: 2, branch: '531', account_number: '778899', display_name: 'סופר על הדרך' },
];

test('מזהה מלא מהסקרייפר מותאם לפי סניף+חשבון', async () => {
  const r = resolveScrapedAccount(rows);
  assert.equal(r('12-628-432110')?.id, 1);
  assert.equal(r('12-531-778899')?.id, 2);
});

test('מספר חשבון לבדו (CSV / Financy) ממשיך לעבוד', async () => {
  const r = resolveScrapedAccount(rows);
  assert.equal(r('432110')?.id, 1);
  assert.equal(r('778899')?.id, 2);
});

// 🔴 הכלל: חשבון שאינו מזוהה **מדווח ולא מנוחש**. משיכה שתופסת חשבון נוסף (פק"מ, חשבון רדום)
// לא תזליג את התנועות שלו לספר של חנות אחרת.
test('חשבון שאינו רשום מחזיר null ולא ניחוש', async () => {
  const r = resolveScrapedAccount(rows);
  assert.equal(r('12-999-111222'), null);
  assert.equal(r(''), null);
  assert.equal(r(null), null);
});

// סניף שונה, אותו מספר חשבון: דו-משמעות אמיתית. עדיף לדווח מאשר להכניס כסף לספר הלא נכון.
test('מספר חשבון כפול בשני סניפים אינו מותאם לפי המספר לבדו', async () => {
  const dup = [
    { id: 1, branch: '628', account_number: '432110', display_name: 'א' },
    { id: 2, branch: '531', account_number: '432110', display_name: 'ב' },
  ];
  const r = resolveScrapedAccount(dup);
  assert.equal(r('12-628-432110')?.id, 1, 'עם סניף — חד-משמעי');
  assert.equal(r('12-531-432110')?.id, 2);
  assert.equal(r('432110')?.id, 2, 'התאמה מלאה קיימת (האחרון שנכתב) — לא דו-משמעות');
  assert.equal(r('12-777-432110'), null, 'סניף לא מוכר + מספר כפול = מדווח, לא מנוחש');
});

// ארבעה חשבונות תחת אותה התחברות — התרחיש בפועל.
test('ארבעה חשבונות משויכים כל אחד לספר שלו', async () => {
  const four = [
    { id: 1, branch: '628', account_number: '432110', display_name: 'א' },
    { id: 2, branch: '628', account_number: '432111', display_name: 'ב' },
    { id: 3, branch: '531', account_number: '778899', display_name: 'ג' },
    { id: 4, branch: '777', account_number: '100200', display_name: 'ד' },
  ];
  const r = resolveScrapedAccount(four);
  const got = ['12-628-432110', '12-628-432111', '12-531-778899', '12-777-100200'].map((k) => r(k)?.id);
  assert.deepEqual(got, [1, 2, 3, 4]);
});
