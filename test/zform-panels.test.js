// מבנה הרובריקות בטופס ה-Z: "הוצאות במזומן" ו"הכנסות מאשראי".
//
// שלוש הדרישות של הבעלים, כל אחת נעולה כאן:
//   • **הכותרת כולה היא הכפתור** — <details>/<summary>, לא אייקון עגול לצדה. שטח לחיצה גדול,
//     עובד במקלדת, ומצב פתוח/סגור הוא של הדפדפן ולא onclick משלנו.
//   • **הכנסות מאשראי משמאל להוצאות במזומן** — ב-RTL, כלומר שנייה בסדר המקור.
//   • **ההזנה בחלון נפרד**, והרובריקה עצמה מציגה סיכום בצורת טבלת האשראי.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const view = fs.readFileSync(path.join(process.cwd(), 'src/views/reports/_zform.ejs'), 'utf8');

test('each rubric is a <details>, so the whole header is the toggle', () => {
  assert.match(view, /<details class="zpanel no-collapse" id="cx-panel"/);
  assert.match(view, /<details class="zpanel no-collapse" id="cc-panel">/);
  assert.ok(!/class="round-btn"[^>]*onclick="var p=document\.getElementById\('c[xc]-panel'\)/.test(view),
    'the round icon button is gone — the header itself is the button now');
});

test('הכנסות מאשראי sits to the LEFT of הוצאות במזומן (second in RTL source order)', () => {
  const cx = view.indexOf('id="cx-panel"');
  const cc = view.indexOf('id="cc-panel"');
  assert.ok(cx > 0 && cc > 0);
  assert.ok(cx < cc, 'cash expenses first (right), credit second (left)');
  assert.match(view, /<div class="zpanels">/);
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

test('both panel toggles use .open — a <details> ignores .hidden', () => {
  assert.ok(!/getElementById\('cc-panel'\)\.hidden/.test(view),
    'setting .hidden on a <details> silently does nothing, and the mismatch panel would never open');
  assert.match(view, /getElementById\('cc-panel'\)\.open = true/);
});

test('the small entry/summary tables opt out of the global search+export toolbar', () => {
  assert.match(view, /<table class="zsum-table no-enhance">/);
  assert.match(view, /<table class="no-enhance" style="max-width:420px">/);
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
