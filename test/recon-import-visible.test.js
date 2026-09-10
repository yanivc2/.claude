// "הייתה אפשרות להעלות קובץ פעולות ואני לא רואה אותה."
//
// היא הייתה שם כל הזמן — שני אייקונים עגולים בכרטיס בלי כותרת, בתחתית הדף. נמדד בדפדפן:
// 916px בדסקטופ ו-1355px בנייד, כלומר **מתחת לקפל בשני המקרים**. פעולה קיימת שאיש לא מוצא
// שקולה לפעולה שאינה קיימת, וזו כאן הפעולה הראשונה בדף — בלי תנועות אין מה להתאים.
//
// לכן היא יושבת בכרטיס העליון, ליד בורר החשבון והמשיכה מהבנק, כטקסט ולא כאייקון.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const view = fs.readFileSync(path.join(process.cwd(), 'src/views/reconciliation/index.ejs'), 'utf8');
const topCard = view.slice(0, view.indexOf('תנועות לא מותאמות'));

test('the import action lives in the top card, above everything else', () => {
  assert.match(topCard, /showModal\(\)">📄 ייבוא CSV \/ Excel<\/button>/,
    'the file-import button must be in the first card, not at the bottom of the page');
  assert.match(topCard, /showModal\(\)">➕ הוספת תנועה ידנית<\/button>/);
});

test('the round icon tiles are gone — one action, one place', () => {
  assert.ok(!/icon-circle accent[\s\S]{0,200}csvDlg/.test(view), 'the bottom tile card was removed');
  const opens = (view.match(/getElementById\('csvDlg'\)\.showModal\(\)/g) || []).length;
  assert.equal(opens, 2, 'exactly two: the top card and the empty state — never a duplicate control');
});

test('the empty state offers the import instead of only naming it', () => {
  const empty = view.slice(view.indexOf('אין תנועות בחשבון'), view.indexOf('אין תנועות בחשבון') + 400);
  assert.match(empty, /showModal/, 'with no transactions at all, the button belongs right there');
});

test('the dialog it opens still posts a file to the import route', () => {
  const dlg = view.slice(view.indexOf('<dialog id="csvDlg"'), view.indexOf('</dialog>', view.indexOf('<dialog id="csvDlg"')));
  assert.match(dlg, /action="\/reconciliation\/import-csv"/);
  assert.match(dlg, /enctype="multipart\/form-data"/);
  assert.match(dlg, /type="file"/);
});

test('🔒 the action stays behind the import permission', () => {
  // Moving a control must not quietly widen who can use it.
  const guarded = view.slice(view.indexOf("can('import_bank')"));
  assert.ok(view.indexOf("can('import_bank')") < view.indexOf('📄 ייבוא CSV / Excel'),
    'the button is inside the permission check');
  assert.ok(guarded.includes('📄 ייבוא CSV / Excel'));
});
