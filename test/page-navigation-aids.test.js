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

test('the store bar is the header row: back on its right side, picker centred, logo far left, sidebar full height (owner, 17/10)', () => {
  assert.match(footer, /var side = document\.querySelector\('\.store-banner \.sb-start'\);/);
  assert.match(footer, /side\.appendChild\(a\);/, '"→ חזרה" joins the right side, left of "אפשרויות"');
  assert.match(footer, /bar\.className = 'page-back no-print';/, 'a page without the bar keeps its own row');
  const desk = css.slice(css.indexOf('@media (min-width: 1000px) {\n  .topbar {'));
  assert.ok(desk.length > 100, 'a desktop header-row block exists');
  assert.match(desk, /position: fixed; top: 0;[^}]*inset-inline-start: 250px; inset-inline-end: 0;/, 'over the content area only — the sidebar keeps its full height');
  assert.match(desk, /\.topbar-inner \{ max-width: 1120px;[^}]*padding: 0 var\(--space-6\); \}/, 'same geometry as .page → "אפשרויות" right edge = the first tile right edge');
  assert.match(desk, /grid-template-columns: 1fr auto 1fr;/, 'right side · centred picker · left side');
  assert.match(desk, /\.topbar-brand \{ display: inline-flex; position: absolute; left: 18px;/, '"AP Control" at the far left');
  assert.match(css, /main\.page \.page-back \{ text-align: start !important; \}/);
});

test('phone: the page name sits in the centre of the header row and the page h1 is not repeated (owner, 17/10)', () => {
  const header = readFileSync(new URL('../src/views/partials/header.ejs', import.meta.url), 'utf8');
  assert.match(header, /<span class="nav-title">/);
  assert.match(header, /t\.textContent = h\.textContent\.replace\(\/\\s\+\/g, ' '\)\.trim\(\); h\.classList\.add\('h1-in-header'\);/);
  assert.match(css, /main\.page \.h1-in-header \{ display: none; \}/);
});

test('"למעלה" is unmistakable and never covers a sticky bottom bar (owner, 17/10: "לא מובן שזה חץ למעלה")', () => {
  assert.match(footer, /<path fill="currentColor" d="M12 3l-8 8h5v10h6V11h5z"\/><\/svg><span>למעלה<\/span>/, 'a solid arrow + the word');
  assert.match(footer, /document\.querySelectorAll\('\.pay-bar, \.zform-save'\)/, 'lifted above "הנפק תשלום לנבחרים" / Z save bar');
  assert.match(footer, /top\.style\.bottom = lift \+ 'px';/);
  assert.match(css, /\.to-top \{[^}]*background: var\(--color-accent\); color: #fff;/);
});

test('"→ חזרה" does not drop when pressed — no transform-based positioning (owner, 17/10)', () => {
  // `button:active, .btn:active { transform: translateY(1px) }` once replaced a centring translateY(-50%),
  // so the button fell by half its height while the mouse was down. It now sits in the flow of the bar.
  const i = css.indexOf('.store-banner-back {');
  const rule = i >= 0 ? css.slice(i, css.indexOf('}', i)) : '';
  assert.ok(!/transform/.test(rule), 'no transform on the back button');
  assert.ok(!/\.store-banner-back \{[^}]*translateY/.test(css));
});
