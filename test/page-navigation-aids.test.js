// בעלים, 16/10: "כשאני לוחץ על 'טופל' זה מקפיץ אותי לראש הדף ומצמצם את הטבלה" · "תמיד אפשרות לחזור
// אחורה בלחיצת כפתור" · "כפתור שיקפיץ אותי למעלה" · "קו מצד ימין שאפשר לגרור — מהר, אבל בשליטה".
// כל אלה ב-partials/footer.ejs, כלומר בכל דף. בדיקה בדפדפן נעשתה ידנית (Playwright); כאן — שהם קיימים.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');

test('every POST form keeps the scroll AND the open lists — not only data-keep-scroll forms', () => {
  assert.match(footer, /var post = String\(f\.getAttribute\('method'\) \|\| ''\)\.toLowerCase\(\) === 'post';/);
  assert.match(footer, /open: open, closed: closed, groups: groups/, 'open and closed <details> are remembered');
  assert.match(footer, /if \(!d\.open && want\.indexOf\(k\) >= 0\) d\.open = true;/, 'and reopened after the redirect');
  assert.match(footer, /!location\.hash/, 'an #anchor in the URL wins');
});

test('a back button on every page, built from a stack of DIFFERENT pages (an action does not count)', () => {
  assert.match(footer, /var NAVK = 'apNavStack';/);
  assert.match(footer, /st\[st\.length - 1\] === cur\) \{ \/\* אותו דף/, 'the same page after POST→303 is not pushed again');
  assert.match(footer, /TRANSIENT = \/\^\(notice\|err\|error\|cashErr\|cashNote/, 'one-off notices do not make a new page');
  assert.match(footer, /a\.textContent = '→ חזרה';/);
});

test('to-top button and a draggable scroll rail (mouse only, long pages only)', () => {
  assert.match(footer, /top\.className = 'to-top no-print';/);
  assert.match(footer, /top\.hidden = window\.scrollY < 600;/);
  assert.match(footer, /matchMedia\('\(pointer: fine\)'\)/, 'the rail is for a mouse — not on touch');
  assert.match(footer, /window\.scrollTo\(0, range > 0 \? \(t \/ range\) \* max : 0\)/, 'dragging maps the thumb to the whole page');
  assert.match(css, /\.scroll-rail \{[^}]*position: fixed;/);
  assert.match(css, /\.to-top \{[^}]*position: fixed;/);
});

test('"→ חזרה" sits inside the store bar, at its right edge, and the bar is centered (owner, 17/10)', () => {
  assert.match(footer, /var banner = main\.querySelector\(':scope > \.store-banner'\);/);
  assert.match(footer, /banner\.insertBefore\(a, banner\.firstChild\);/, 'into the bar when there is one');
  assert.match(footer, /bar\.className = 'page-back no-print';/, 'a page without the bar keeps its own row');
  assert.match(css, /\.store-banner \{ justify-content: center; position: relative; \}/);
  assert.match(css, /\.store-banner-back \{ position: absolute; inset-inline-start: 12px;/, 'inline-start = right in RTL');
  assert.match(css, /main\.page \.page-back \{ text-align: start !important; \}/);
});
