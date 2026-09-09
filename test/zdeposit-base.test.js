// "חוסר / יתרה" בהצהרת ההפקדה — הנוסחה שהבעלים תיקן.
//
// מה שהיה שגוי: הבסיס היה **סה"כ המגירה** (מזומן + צ׳ק + אשראי + הקפה + תווי קניה) פלוס ההוצאות.
// אבל הפקדת מזומן לבנק אין לה קשר לאשראי או לצ׳קים, ולכן כל יום עם הכנסות מאשראי הציג "חוסר"
// בגובה האשראי — כלומר כמעט כל יום, וכל המסך הפך לרעש שאי אפשר לסמוך עליו.
//
// הנכון: **מזומן מדוח המגירה + סה"כ ההוצאות במזומן**.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { depositBase, depositDiff } from '../src/services/zreports.js';

// יום טיפוסי: ₪1,000 מזומן, ₪5,000 אשראי, ₪300 צ׳ק — ו-₪200 הוצאות מזומן מהקופה.
const Z = { drawer_cash: 100000, drawer_credit: 500000, drawer_check: 30000, drawer_total: 630000 };
const EXPENSES = 20000;

test('the base is cash + cash expenses — credit, cheques and הקפה are not part of a cash deposit', () => {
  assert.equal(depositBase(Z, EXPENSES), 120000, '₪1,000 מזומן + ₪200 הוצאות');
  assert.notEqual(depositBase(Z, EXPENSES), Z.drawer_total + EXPENSES, 'never the drawer TOTAL');
});

test('a deposit that matches the cash is תואם, not a huge חוסר', () => {
  // This is the bug in one line: the old base would have called this a ₪5,300 shortfall.
  assert.equal(depositDiff(Z, EXPENSES, 120000), 0);
  const oldBase = Z.drawer_total + EXPENSES;
  assert.equal(120000 - oldBase, -530000, 'what the screen used to claim was missing');
});

test('a real shortfall and a real surplus still read correctly', () => {
  assert.equal(depositDiff(Z, EXPENSES, 115000), -5000, 'הפקדה קטנה מהמזומן → חוסר');
  assert.equal(depositDiff(Z, EXPENSES, 125000), 5000, 'הפקדה גדולה → יתרה');
});

test('missing pieces are zero, never NaN — a blank field must not poison the number', () => {
  assert.equal(depositBase({}, 0), 0);
  assert.equal(depositBase(null, null), 0);
  assert.equal(depositBase({ drawer_cash: '100000' }, '20000'), 120000, 'strings from the form still add up');
  assert.equal(depositDiff(Z, EXPENSES, null), -120000);
});

test('🔴 the live calculation in the form uses the same two inputs as the server', () => {
  // The formula exists twice — server (this service) and the in-page JS that updates while typing.
  // If they drift, the number changes the moment you save, which is worse than either being wrong.
  const form = fs.readFileSync(path.join(process.cwd(), 'src/views/reports/_zform.ejs'), 'utf8');
  assert.match(form, /function drawerCash\(\)\s*{\s*return num\(form\.querySelector\('input\[name="drawer_cash"\]'\)\)/,
    'the form must read the CASH field, not sum every drawer input');
  assert.match(form, /num\(depAmtEl\) - \(drawerCash\(\) \+ cxSum\(\)\)/,
    'deposit − (cash + cash expenses)');
  assert.ok(!/num\(depAmtEl\) - \(drawerSum\(\)/.test(form), 'drawerSum() is the whole drawer — that was the bug');
});
