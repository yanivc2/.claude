// "איפה מוסיפים מפרעה?" — הטופס היה קיים, כ-<details> דק בתחתית הכרטיס, ופשוט לא נראה.
//
// שני הכללים שנשמרים כאן הם מה שנשבר אז:
//   • הפעולה חייבת להיות כפתור נראה — גם בכותרת הרובריקה וגם במצב הריק, שם העין ממילא נמצאת
//     כשאין עדיין שום שורה;
//   • הטבלה הרחבה חייבת להתקפל לכרטיס מתויג בנייד (`.line-grid` + `data-label`), אחרת עשר עמודות
//     נמעכות ל-390px והסכום נחתך — אותה תקלה שכבר תוקנה פעמיים בקוד הזה.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const view = fs.readFileSync(path.join(process.cwd(), 'src/views/employees/index.ejs'), 'utf8');

test('the add-advance action is a visible button, and it ships with the dialog it opens', () => {
  const opens = [...view.matchAll(/getElementById\('add-advance'\)\.showModal\(\)/g)];
  assert.ok(opens.length >= 2, 'one button in the card header AND one in the empty state');
  assert.match(view, /<dialog id="add-advance">/, 'the dialog the buttons open must be on the page');
  assert.match(view, /action="\/employees\/advances"/, 'and it must post to the create route');
  assert.ok(
    !/<details[^>]*>\s*<summary[^>]*>\s*<strong>הוספת מפרעה/.test(view),
    'never back to a thin <details> at the bottom of the card — that is what nobody found',
  );
});

test('the empty state offers the action instead of only saying there is nothing', () => {
  const empty = view.slice(view.indexOf('אין מפרעות רשומות'), view.indexOf('אין מפרעות רשומות') + 400);
  assert.match(empty, /showModal/, 'with no rows at all, the button has to be right there');
});

test('the advances table collapses to labelled cards on a phone', () => {
  const start = view.indexOf('<table class="sortable line-grid">');
  assert.ok(start > 0, 'the wide table must use the .line-grid technique (see nocturne.css)');
  // Only the OUTER row: the repayments table nested under it is its own (narrow) table.
  const table = view.slice(start, view.indexOf('<% if (a.repayments.length) { %>', start));
  const cells = [...table.matchAll(/<td(?![^>]*(?:data-label|colspan))[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(cells, [], `every column needs data-label for the card layout, missing: ${cells.join(' ')}`);
  for (const label of ['תאריך', 'עובד', 'סוג', 'ניתן ב', 'חנות', 'סכום', 'הוחזר', 'יתרה', 'סטטוס', 'פעולות']) {
    assert.ok(table.includes(`data-label="${label}"`), `missing data-label="${label}"`);
  }
});

test('a dialog focuses its heading, not the combobox that would cover the fields', () => {
  for (const m of view.matchAll(/<dialog id="(add-advance|repay-[^"]*)"[^>]*>([\s\S]*?)<\/dialog>/g)) {
    assert.match(m[2], /<h3 tabindex="-1" autofocus/,
      `dialog ${m[1]}: without this the js-combo takes focus, opens, and hides the date and amount`);
  }
});
