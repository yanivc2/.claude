// "חוסר / יתרה" בהצהרת ההפקדה — הנוסחה, אחרי שני תיקונים של הבעלים.
//
// תיקון ראשון: הבסיס היה **סה"כ המגירה** (מזומן + צ׳ק + אשראי + הקפה + תווי קניה). להפקדת מזומן
// אין קשר לאשראי או לצ׳קים, ולכן כל יום עם הכנסות מאשראי הציג "חוסר" בגובה האשראי.
//
// תיקון שני: ההוצאות היו **מתווספות** למזומן. כסף שיצא מהקופה כהוצאה כבר אינו בקופה ולא יכול
// להגיע לשקית, ולכן הוא **מופחת**:
//   בסיס = מזומן (דוח מגירה) − (צ׳ק + סה"כ הוצאות במזומן)   ("כמה אמור להגיע לשקית")
// תיקון שלישי (2026-10-04): צ׳ק אינו כסף בשקית — מופחת מהמזומן כמו ההוצאות. תווי קניה — לא.
// תיקון רביעי (2026-10-12): "החישוב הנכון ללא הקפה" — הקפה יצאה מהנוסחה (השדה נשאר בטופס).
//   הפרש = סה"כ הופקד − בסיס
// 🔴 הכיוון, כפי שהבעלים הגדיר אותו: **הפקידו פחות ממה שהיה בקופה → חוסר**; הפקידו יותר → יתרה.
// כלומר כסף שהיה אמור להגיע לשקית ולא הגיע הוא חוסר.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { depositBase, depositDiff } from '../src/services/zreports.js';

// יום טיפוסי: ₪1,000 מזומן, ₪5,000 אשראי, ₪300 צ׳ק — ו-₪200 הוצאות מזומן מהקופה.
const Z = { drawer_cash: 100000, drawer_credit: 500000, drawer_check: 30000, drawer_total: 630000 };
const EXPENSES = 20000;

test('הבסיס = מזומן פחות צ׳ק והוצאות — אשראי אינו נכנס', () => {
  assert.equal(depositBase(Z, EXPENSES), 50000, '₪1,000 מזומן − (₪300 צ׳ק + ₪200 הוצאות) = ₪500');
  assert.equal(depositBase({ drawer_cash: 100000 }, EXPENSES), 80000, 'בלי צ׳ק: ₪1,000 − ₪200 = ₪800');
  assert.notEqual(depositBase(Z, EXPENSES), Z.drawer_total + EXPENSES, 'לעולם לא סה"כ המגירה');
  assert.notEqual(depositBase(Z, EXPENSES), 150000, 'ולא חיבור ההוצאות — זה היה התיקון השני');
});

test('הפקדה ששווה למזומן פחות ההוצאות היא "תואם"', () => {
  assert.equal(depositDiff(Z, EXPENSES, 50000), 0);
});

test('🔴 הכיוון: הפקידו פחות → חוסר; הפקידו יותר → יתרה', () => {
  // הפקידו ₪450 מתוך ₪500 שהיו אמורים להגיע לשקית → ₪50 חסרים
  assert.equal(depositDiff(Z, EXPENSES, 45000), -5000, 'הפקדה קטנה מהזמין → חוסר');
  // הפקידו ₪550 כשהיו אמורים ₪500 → ₪50 מעבר
  assert.equal(depositDiff(Z, EXPENSES, 55000), 5000, 'הפקדה גדולה מהזמין → יתרה');
});

test('המקרה שדווח מהמסך: ₪52,269.80 מזומן, ₪1,000 הוצאות, ₪51,230 הופקד', () => {
  const real = { drawer_cash: 5226980 };
  assert.equal(depositBase(real, 100000), 5126980, 'אמור להגיע לשקית: ₪51,269.80');
  const d = depositDiff(real, 100000, 5123000);
  assert.equal(d, -3980, 'חוסר של ₪39.80');
  assert.ok(d < 0, 'חוסר — הפקידו פחות ממה שהיה אמור להגיע לשקית');
  // מה שהמסך הראה קודם: חוסר ₪2,039.80 — ניפוח בגובה כפל ההוצאות.
  assert.equal(5123000 - (5226980 + 100000), -203980);
});

test('חלקים חסרים הם אפס, לעולם לא NaN — שדה ריק לא מרעיל את המספר', () => {
  assert.equal(depositBase({}, 0), 0);
  assert.equal(depositBase(null, null), 0);
  assert.equal(depositBase({ drawer_cash: '100000' }, '20000'), 80000, 'מחרוזות מהטופס מחושבות נכון');
  assert.equal(depositDiff(Z, EXPENSES, null), -50000, 'בלי הפקדה — כל מה שהיה אמור להיות מופקד חסר');
});

test('🔴 הקפה לא בנוסחה (12/10): Z 2181 — מזומן 90,737.90, הקפה 162.13, הוצאות 4,170.55, הופקד 86,371', () => {
  const z = { drawer_cash: 9073790, drawer_hakafa: 16213, drawer_check: 0, drawer_vouchers: 50000, drawer_credit: 19765686 };
  assert.equal(depositBase(z, 417055), 8656735, 'אמור להגיע לשקית ₪86,567.35 — ההקפה לא מופחתת');
  assert.equal(depositDiff(z, 417055, 8637100), -19635, 'חוסר ₪196.35');
  assert.equal(depositBase({ drawer_vouchers: 1000, drawer_check: 2000, drawer_hakafa: 3000, drawer_cash: 10000 }, 0), 8000, 'רק צ׳ק מופחת — לא הקפה ולא תווי קניה');
  assert.equal(depositBase({ drawer_cash: 10000, drawer_hakafa: 999999 }, 0), 10000, 'הקפה בכל גודל לא משנה את המספר');
});

test('🔴 החישוב החי בטופס משתמש באותה נוסחה בדיוק כמו השרת', () => {
  // הנוסחה קיימת פעמיים — בשירות ובקוד שרץ בדף בזמן ההקלדה. אם הן נפרדות, המספר משתנה ברגע
  // השמירה, וזה גרוע משתיהן להיות שגויות.
  const form = fs.readFileSync(path.join(process.cwd(), 'src/views/reports/_zform.ejs'), 'utf8');
  assert.match(form, /function drawerCash\(\)\s*{\s*return num\(form\.querySelector\('input\[name="drawer_cash"\]'\)\)/,
    'הטופס קורא את שדה המזומן, לא סוכם את כל המגירה');
  assert.match(form, /depSum\(\) - \(drawerCash\(\) - \(nonCash\(\) \+ cxSum\(\)\)\)/,
    'הפקדה − (מזומן − (צ׳ק + הוצאות)); depSum() סוכם את כל השקיות');
  assert.match(form, /function nonCash\(\)[\s\S]{0,120}\['drawer_check'\]\.reduce/,
    'nonCash = צ׳ק בלבד — לא הקפה, לא תווי קניה ולא אשראי');
  assert.ok(!/depSum\(\) - \(drawerCash\(\) \+ cxSum\(\)\)/.test(form), 'חיבור ההוצאות היה הבאג');
  assert.match(form, /function depSum\(\)[\s\S]{0,200}\.dep-amt/,
    'צד ההפקדה סוכם את כל שורות השקיות, לא את הראשונה');
  assert.ok(!/num\(depAmtEl\) - \(drawerSum\(\)/.test(form), 'drawerSum() הוא כל המגירה — זה היה הבאג הראשון');
  // התווית מתחת לשדה חייבת לומר את אותה נוסחה, אחרת המסך מסביר משהו אחר ממה שהוא מחשב.
  assert.match(form, /הפקדה − \(מזומן − \(צ'ק \+ הוצאות במזומן\)\)/);
  assert.ok(!/הפקדה − \(מזומן − \(צ'ק \+ הקפה/.test(form), 'התווית לא מזכירה הקפה');
});
