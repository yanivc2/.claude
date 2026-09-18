// "חוסר / יתרה" בהצהרת ההפקדה — הנוסחה, אחרי שני תיקונים של הבעלים.
//
// תיקון ראשון: הבסיס היה **סה"כ המגירה** (מזומן + צ׳ק + אשראי + הקפה + תווי קניה). להפקדת מזומן
// אין קשר לאשראי או לצ׳קים, ולכן כל יום עם הכנסות מאשראי הציג "חוסר" בגובה האשראי.
//
// תיקון שני: ההוצאות היו **מתווספות** למזומן. כסף שיצא מהקופה כהוצאה כבר אינו בקופה ולא יכול
// להגיע לשקית, ולכן הוא **מופחת**:
//   בסיס = מזומן (דוח מגירה) − סה"כ הוצאות במזומן   ("כמה אמור היה להגיע לשקית")
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

test('הבסיס = מזומן פחות ההוצאות — אשראי, צ׳קים והקפה אינם חלק מהפקדת מזומן', () => {
  assert.equal(depositBase(Z, EXPENSES), 80000, '₪1,000 מזומן − ₪200 הוצאות = ₪800');
  assert.notEqual(depositBase(Z, EXPENSES), Z.drawer_total + EXPENSES, 'לעולם לא סה"כ המגירה');
  assert.notEqual(depositBase(Z, EXPENSES), 120000, 'ולא חיבור ההוצאות — זה היה התיקון השני');
});

test('הפקדה ששווה למזומן פחות ההוצאות היא "תואם"', () => {
  assert.equal(depositDiff(Z, EXPENSES, 80000), 0);
});

test('🔴 הכיוון: הפקידו פחות → חוסר; הפקידו יותר → יתרה', () => {
  // הפקידו ₪750 מתוך ₪800 שהיו אמורים להגיע לשקית → ₪50 חסרים
  assert.equal(depositDiff(Z, EXPENSES, 75000), -5000, 'הפקדה קטנה מהזמין → חוסר');
  // הפקידו ₪850 כשהיו אמורים ₪800 → ₪50 מעבר
  assert.equal(depositDiff(Z, EXPENSES, 85000), 5000, 'הפקדה גדולה מהזמין → יתרה');
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
  assert.equal(depositDiff(Z, EXPENSES, null), -80000, 'בלי הפקדה — כל מה שהיה אמור להיות מופקד חסר');
});

test('🔴 החישוב החי בטופס משתמש באותה נוסחה בדיוק כמו השרת', () => {
  // הנוסחה קיימת פעמיים — בשירות ובקוד שרץ בדף בזמן ההקלדה. אם הן נפרדות, המספר משתנה ברגע
  // השמירה, וזה גרוע משתיהן להיות שגויות.
  const form = fs.readFileSync(path.join(process.cwd(), 'src/views/reports/_zform.ejs'), 'utf8');
  assert.match(form, /function drawerCash\(\)\s*{\s*return num\(form\.querySelector\('input\[name="drawer_cash"\]'\)\)/,
    'הטופס קורא את שדה המזומן, לא סוכם את כל המגירה');
  assert.match(form, /depSum\(\) - \(drawerCash\(\) - cxSum\(\)\)/,
    'הפקדה − (מזומן − הוצאות); depSum() סוכם את כל השקיות, כי הפקדה יכולה להתפצל');
  assert.ok(!/depSum\(\) - \(drawerCash\(\) \+ cxSum\(\)\)/.test(form), 'חיבור ההוצאות היה הבאג');
  assert.match(form, /function depSum\(\)[\s\S]{0,200}\.dep-amt/,
    'צד ההפקדה סוכם את כל שורות השקיות, לא את הראשונה');
  assert.ok(!/num\(depAmtEl\) - \(drawerSum\(\)/.test(form), 'drawerSum() הוא כל המגירה — זה היה הבאג הראשון');
  // התווית מתחת לשדה חייבת לומר את אותה נוסחה, אחרת המסך מסביר משהו אחר ממה שהוא מחשב.
  assert.match(form, /הפקדה − \(מזומן מגירה − הוצאות במזומן\)/);
});
