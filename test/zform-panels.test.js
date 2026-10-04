// מבנה הרובריקות בטופס ה-Z: "הוצאות במזומן" ו"הכנסות מאשראי".
//
// דרישות הבעלים, כל אחת נעולה כאן:
//   • **שתי הרובריקות תמיד פתוחות** (2026-10-04 — קודם היו <details> מתקפלים), באותו גובה מרבי.
//   • **הכנסות מאשראי מימין להוצאות במזומן** — ב-RTL, כלומר ראשונה בסדר המקור (התהפך ב-2026-10-04).
//   • **ההזנה בחלון נפרד**, והרובריקה עצמה מציגה סיכום בצורת טבלת האשראי.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const view = fs.readFileSync(path.join(process.cwd(), 'src/views/reports/_zform.ejs'), 'utf8');

test('both rubrics are always open — plain sections, no <details> toggle', () => {
  assert.match(view, /<section class="zpanel" id="cc-panel">/);
  assert.match(view, /<section class="zpanel" id="cx-panel">/);
  assert.ok(!/<details class="zpanel/.test(view), 'owner: the two tables are always shown, never collapsed');
  assert.ok(!/getElementById\('c[cx]-panel'\)\.open/.test(view), 'nothing toggles them open any more');
});

// פריסת הבעלים (2026-10-04). ב-RTL הילד הראשון בכל זוג ברשת הוא הימני.
test('drawer layout: credit | expenses, vouchers | check, hakafa | cash, total, credit-drawer', () => {
  const grid = view.slice(view.indexOf('<div class="zdrawer">'), view.indexOf('<%# חלון ההזנה.'));
  const order = ['id="cc-panel"', 'id="cx-panel"', 'name="drawer_vouchers"', 'name="drawer_check"',
    'name="drawer_hakafa"', 'name="drawer_cash"', 'id="drawer_total"', 'name="drawer_credit"'];
  const at = order.map((k) => grid.indexOf(k));
  at.forEach((p, i) => assert.ok(p > 0, `${order[i]} is inside the drawer grid`));
  for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `${order[i - 1]} before ${order[i]}`);
  assert.match(grid, /<label>מזומן מגירה<\/label><input name="drawer_cash" class="dr"/);
  assert.ok(!/drawer_expenses_total/.test(view), 'the separate "סה"כ הוצאות במזומן" field is gone — the table has its total');
  // every drawer component still feeds the total and the recon, wherever it sits
  for (const n of ['drawer_cash', 'drawer_check', 'drawer_credit', 'drawer_hakafa', 'drawer_vouchers']) {
    assert.match(view, new RegExp(`name="${n}"[^>]*class="dr"`), `${n} keeps class="dr"`);
  }
});

test('deposit: bags | total on the last bag row, then add button | gap', () => {
  const a = view.indexOf('<div class="zdep-layout">');
  assert.ok(a > 0);
  const bags = view.indexOf('<div id="dep-bags">', a);
  const add = view.indexOf('onclick="depAdd()"', a);
  const tot = view.indexOf('id="dep_total"', a);
  const gap = view.indexOf('id="dep_recon"', a);
  assert.ok(bags < tot && tot < add && add < gap, '[bags | total] then [add button | gap] — RTL pairs');
  const css = fs.readFileSync(path.join(process.cwd(), 'src/public/nocturne.css'), 'utf8');
  assert.match(css, /\.zdep-layout > \.zdep-total \{[^}]*align-self: end/, 'the total sits on the last bag row as bags are added');
  assert.match(css, /\.zpanel-body \{[^}]*max-height: \d+px; overflow-y: auto/, 'both rubrics share one max height');
  assert.match(view, /<p class="muted zdep-intro"/);
  assert.match(css, /\.zdep-intro \{ max-width: calc\(\(100% - var\(--space-4\)\) \/ 2\); \}/, 'the explanation stays within the right column');
});

test('entry moved into a dialog, and the rubric shows a summary in the credit table\'s shape', () => {
  assert.match(view, /<dialog id="cx-dialog" class="cx-dialog">/);
  assert.match(view, /getElementById\('cx-dialog'\)\.showModal\(\)/, 'a button opens it');
  // The entry rows kept their markup — four screens share this layout (see cash-expense-layout.test.js).
  const dialog = view.slice(view.indexOf('<dialog id="cx-dialog"'), view.indexOf('</dialog>'));
  assert.match(dialog, /<div id="cx-body" class="cx-list">/);
  assert.match(view, /<tbody id="cx-summary"><\/tbody>/, 'the summary is built from the live rows');
  assert.match(view, /<th class="right" id="cx_total_disp">/);
});

test('a credit mismatch on submit scrolls to the (always-open) credit table', () => {
  assert.match(view, /getElementById\('cc-panel'\)\.scrollIntoView/);
});

test('the small entry/summary tables opt out of the global search+export toolbar', () => {
  assert.match(view, /<table class="zsum-table no-enhance">/);
  assert.equal((view.match(/<table class="zsum-table no-enhance">/g) || []).length, 2, 'credit + expenses');
});

test('deposit bags repeat, carry an id, and index their own checkbox', () => {
  assert.match(view, /<div id="dep-bags">/);
  assert.match(view, /name="dep_id"/, 'an existing bag must update in place, never delete-and-recreate');
  assert.match(view, /name="dep_amount" class="dep-amt"/);
  // A checkbox posts nothing when off, so it carries its row index instead of relying on position.
  assert.match(view, /name="dep_deposited" value="<%= i %>"/);
  assert.match(view, /onclick="depAdd\(\)"/);
  assert.match(view, /function depSum\(\)/, 'the recon must total every bag');
});
