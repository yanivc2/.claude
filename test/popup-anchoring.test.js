// רשימות צפות — בורר החיפוש (`.combo-pop`) ולוח התאריכים (`.dp-pop`).
//
// שתי תקלות שנתפסו בדפדפן, שתיהן מאותו שורש, ושתיהן חוזרות ברגע שמישהו "מפשט" בחזרה ל-absolute:
//
//   1. **absolute נחתך.** רשימה בתוך `.table-scroll` (overflow:auto) נחתכה בגבול הגלילה. כל אב
//      עם overflow שאינו visible חותך צאצא absolute — ולכן הרשימה חייבת להיות fixed, ממוקמת מול
//      `getBoundingClientRect` של השדה.
//   2. **fixed על <body> נקבר מתחת ל-<dialog>.** דיאלוג מודאלי מוצג ב-top layer, ואלמנט שיושב על
//      <body> מצויר מתחתיו ואינו ניתן ללחיצה — בשום z-index. לכן ההורה נבחר ברגע הפתיחה:
//      הדיאלוג הפתוח שמכיל את השדה, אחרת <body>. שתי הרשימות עוברות דרך `apPopupHost`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const footer = fs.readFileSync(path.join(process.cwd(), 'src/views/partials/footer.ejs'), 'utf8');
const css = fs.readFileSync(path.join(process.cwd(), 'src/public/nocturne.css'), 'utf8');
const rule = (sel) => css.slice(css.indexOf(`${sel} {`), css.indexOf('}', css.indexOf(`${sel} {`)));

test('both popups are fixed, not absolute — absolute is clipped by any scrolling ancestor', () => {
  for (const sel of ['.combo-pop', '.dp-pop']) {
    const r = rule(sel);
    assert.match(r, /position: fixed/, `${sel} must be fixed`);
    assert.ok(!/position: absolute/.test(r), `${sel} must not go back to absolute`);
  }
});

test('the host is resolved at open time, so a popup inside a modal is not buried under it', () => {
  assert.match(footer, /window\.apPopupHost = function/);
  assert.match(footer, /closest\('dialog\[open\]'\)/, 'an open dialog wins over <body>');
  // Both popups must go through it, or one of them regresses inside a dialog.
  const uses = footer.match(/window\.apPopupHost\(input\)/g) || [];
  assert.equal(uses.length, 2, 'the combo list AND the date panel both re-parent on open');
});

test('a popup repositions while the page or a container scrolls', () => {
  // capture:true — an inner .table-scroll scrolling must move the popup too, not just the window.
  const scrollHandlers = footer.match(/addEventListener\('scroll', function\(\)\{ if \(!\w+(\.el)?\.hidden\) place/g) || [];
  assert.ok(scrollHandlers.length >= 2, 'both popups follow their field on scroll');
  assert.ok(footer.includes("}, true);"), 'registered in the capture phase to catch inner scrollers');
});

test('outside-click closes by the popup and its own field, not by parentNode', () => {
  // The popup is no longer a child of the field's wrapper, so the old parentNode test would have
  // closed the list on every click — including the click that picks an option.
  assert.match(footer, /p\.__comboInput/);
  assert.match(footer, /p\.__dpInput/);
  assert.ok(!/\.dp-pop'\)\.forEach\(function\(p\)\{ if \(!p\.parentNode\.contains/.test(footer));
});

test('the list is never narrower than a name, nor wider than the screen', () => {
  // In a 7-column table on a phone the field is ~33px wide; a list that width is unusable.
  assert.match(footer, /Math\.min\(Math\.max\(r\.width, 240\), window\.innerWidth - 16\)/);
});

test('the salary row has ONE employee picker, and the store has its own column', () => {
  const view = fs.readFileSync(path.join(process.cwd(), 'src/views/employees/index.ejs'), 'utf8');
  const form = view.slice(view.indexOf('action="/employees/salary"'), view.indexOf('</table>', view.indexOf('action="/employees/salary"')));
  assert.match(form, /<% if \(!sStoreId\) \{ %><th>חנות<\/th><% \} %><th>שם העובד<\/th>/,
    'the store picker used to sit inside the employee cell, so the row showed two identical search boxes');
  const cells = form.split('<td>').filter((c) => c.includes('js-combo'));
  for (const c of cells) {
    assert.equal((c.match(/js-combo/g) || []).length, 1, 'one combo per cell — never two stacked');
  }
});
