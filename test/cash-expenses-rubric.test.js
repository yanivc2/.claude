import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { israelStamp } from '../src/lib/loginHours.js';

// created_at נשמר ב-UTC בשני הניבים. שעה שמוצגת כמות שהיא מזיזה כל פעולה 2-3 שעות אחורה —
// ובדיוק בשדה שנועד לענות על "מתי זה הוזן".
test('שעת שמירה מוצגת בשעון ישראל, כולל מעבר שעון קיץ/חורף', () => {
  assert.equal(israelStamp('2026-09-10 15:28:00'), '10/09/26 18:28'); // קיץ, UTC+3
  assert.equal(israelStamp('2026-01-10 15:28:00'), '10/01/26 17:28'); // חורף, UTC+2
  assert.equal(israelStamp('2026-09-10 22:30:00'), '11/09/26 01:30'); // חוצה חצות
  assert.equal(israelStamp(''), '');
  assert.equal(israelStamp(null), '');
  assert.equal(israelStamp('לא תאריך'), '');
});

// 🔴 רובריקת "הוצאות מזומן מהקופה" (cashExpensesByStore) הוסרה בהחלטת הבעלים: היא הייתה טבלה
// שנייה ושונה לאותו דבר, ואותה שורת כסף נראתה אחרת בלוח הבקרה ובמרקורים. שני הדפים מציגים
// עכשיו את **אותו** partials/_unmatchedCash.ejs. מה שנשאר כאן הוא מה שעדיין נכון.
test('שעת השמירה מופיעה בטבלת הוצאות המזומן, והרובריקה קיימת בדף המרקורים', () => {
  const partial = readFileSync(new URL('../src/views/partials/_cashExpenses.ejs', import.meta.url), 'utf8');
  assert.match(partial, /israelStamp\(e\.created_at\)/, 'שעת שמירה מומרת לשעון ישראל, לא מוצגת גולמית');
  assert.match(partial, /reports\/zreports\//, 'שורה של דוח Z מקושרת לדוח שלה');

  // 🔴 אותה תקלה בדיוק ברובריקת הייבואים: `imported_at` נשמר ב-UTC בשני הניבים, וחיתוך
  // המחרוזת הציג שעה מוקדמת ב-2-3 שעות מהשעה שבה הקובץ באמת הועלה.
  const recon = readFileSync(new URL('../src/views/reconciliation/index.ejs', import.meta.url), 'utf8');
  assert.match(recon, /israelStamp\(im\.imported_at\)/);

  const view = readFileSync(new URL('../src/views/payments/index.ejs', import.meta.url), 'utf8');
  assert.match(view, /_unmatchedCash/, 'דף המרקורים משתמש באותו פרשל של לוח הבקרה');
  const dash = readFileSync(new URL('../src/views/dashboard.ejs', import.meta.url), 'utf8');
  assert.match(dash, /_unmatchedCash/, 'ולוח הבקרה באותו פרשל בדיוק');
  assert.ok(!/cashExpensesByStore/.test(view), 'הטבלה השנייה הוסרה');
});
