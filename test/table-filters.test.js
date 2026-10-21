// סינון ומיון בטבלאות — המשפרים הגלובליים ב-partials/footer.ejs.
//
// שני דברים נעולים כאן:
//   • **החלטה אחת על נראוּת שורה.** (עד 19/10) לטבלאות היה "חיפוש בטבלה" גלובלי שמסתיר שורות. שורת
//     הסינון לפי עמודה נבנית בתוך אותו משפר ומזינה את אותה פונקציה — שני מנגנוני הסתרה נפרדים
//     על אותה טבלה נלחמים זה בזה (אחד מסתיר ב-style.display, השני ב-hidden), ותיבה שרוקנת לא
//     הייתה מחזירה שורה שהשני הסתיר.
//   • **מיון תאריכים לפי תאריך.** formatDate מייצר DD/MM/YY, ובלי פירוק שלו כל עמודת תאריך
//     מוינה כמחרוזת — כלומר לפי היום בחודש. זה נראה ממוין ואינו.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const footer = read('src/views/partials/footer.ejs');

test('the column filters live inside the table enhancer, not beside it — and on EVERY table', () => {
  // בעלים, 17/10: "בדף חשבוניות צור בטבלה מסננים, וכן בכל הטבלאות" — opt-out, not opt-in.
  assert.match(footer, /if \(!table\.classList\.contains\('no-filter'\) && table\.tHead\.rows\.length === 1\)/);
  // One filter() decides visibility from the per-column boxes (the free-text "חיפוש בטבלה…" is gone
  // since 19/10 — owner: "תמחק", from every table).
  const fn = footer.slice(footer.indexOf('function filter() {'));
  assert.match(fn.slice(0, 1200), /cols\.every/, 'the column boxes decide visibility');
  assert.doesNotMatch(fn.slice(0, 1200), /toks\.every|search\.value/, 'no free-text search any more');
  assert.ok(
    !/document\.querySelectorAll\('table\.filterable'\)\.forEach/.test(footer),
    'no second, independent pass over filterable tables',
  );
});

test('a column of buttons gets no filter box', () => {
  assert.match(footer, /th\.hasAttribute\('data-nofilter'\) \|\| th\.hasAttribute\('data-nosort'\)/);
});

test('the sorter understands DD/MM/YY, and an explicit data-sort wins', () => {
  assert.match(footer, /getAttribute\('data-sort'\)/, 'a cell may declare its own sort key');
  assert.match(footer, /\^\(\\d\{1,2\}\)\\\/\(\\d\{1,2\}\)\\\/\(\\d\{2\}\|\\d\{4\}\)\$/,
    'DD/MM/YY must parse as a date, or date columns sort by day-of-month');
  assert.match(footer, /Date\.UTC\(yr < 100 \? 2000 \+ yr : yr/, 'a 2-digit year is 20xx');
});

test('the unmatched-transactions table opts into both, and excludes the action column', () => {
  const view = read('src/views/reconciliation/index.ejs');
  const head = view.slice(view.indexOf('תנועות לא מותאמות'), view.indexOf('</thead>', view.indexOf('תנועות לא מותאמות')));
  // no-export (בעלים 21/10, "בטל"): המסננים נשארים, "ייצוא" לא.
  assert.match(head, /<table class="sortable filterable(?: tbl-center)? no-export">/);
  assert.match(read('src/views/partials/footer.ejs'), /if \(table\.classList\.contains\('no-export'\)\) \{ \/\* no export row \*\/ \}/);
  assert.match(head, /<th data-nosort data-nofilter data-filter-slot="autoMatchForm">התאמה<\/th>/,
    'the match column is forms, not text — nothing to sort or filter by; its empty filter cell holds "התאמה אוטומטית" (owner 21/10)');
});

test('the long Z form carries a save bar that stays reachable', () => {
  const form = read('src/views/reports/_zform.ejs');
  assert.match(form, /<div class="zform-save">/);
  assert.match(form, /<button type="submit"><%= submitLabel %><\/button>/);
  const css = read('src/public/nocturne.css');
  const rule = css.slice(css.indexOf('.zform-save {'), css.indexOf('}', css.indexOf('.zform-save {')));
  assert.match(rule, /position: sticky/, 'the button must not sink below four sections of form');
  assert.match(rule, /bottom: 0/);
});

test('few distinct values → a dropdown of exactly those values (exact match); otherwise a text box', () => {
  assert.match(footer, /vals\.length >= 2 && vals\.length <= 12/);
  assert.match(footer, /inp\.dataset\.exact = '1'/);
  assert.match(footer, /colInputs\[idx\]\.dataset\.exact \? norm\(td\.textContent\) === q/);
});
