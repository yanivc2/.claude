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

// בעלים 21/10: "כשאני לוחץ הצג אותן הוא זורק אותי בתחילת העמוד".
test('a view-switching link with data-keep-scroll keeps the place too (plain click only)', () => {
  assert.match(footer, /e\.target\.closest\('a\[data-keep-scroll\]'\)/);
  assert.match(footer, /e\.button !== 0 \|\| e\.metaKey \|\| e\.ctrlKey/, 'a new-tab click saves nothing');
  const recon = readFileSync(new URL('../src/views/reconciliation/index.ejs', import.meta.url), 'utf8');
  assert.match(recon, /&all=1" data-keep-scroll>הצג אותן<\/a>/);
  assert.match(recon, /" data-keep-scroll>הסתר אותן<\/a>/);
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

test('the store bar is the header row: back far right then "אפשרויות", page name centred, picker next to the logo at the far left (owner, 18/10)', () => {
  const header = readFileSync(new URL('../src/views/partials/header.ejs', import.meta.url), 'utf8').replace(/<%#[\s\S]*?%>/g, '');
  assert.match(footer, /var side = document\.querySelector\('\.store-banner \.sb-start'\);/);
  assert.match(footer, /side\.insertBefore\(a, side\.firstChild\);/, '"→ חזרה" is the rightmost, "אפשרויות" after it');
  assert.match(footer, /bar\.className = 'page-back no-print';/, 'a page without the bar keeps its own row');
  assert.doesNotMatch(header, /store-banner-ico|🏪/, 'no store icon');
  assert.doesNotMatch(header.replace(/<noscript>[\s\S]*?<\/noscript>/g, ''), />החלף</, 'no "החלף" button — the picker switches on change');
  assert.match(header, /<div class="sb-center"><span class="topbar-title">/, 'the page name in the centre');
  const end = header.slice(header.indexOf('<div class="sb-side sb-end">'));
  assert.ok(end.indexOf('store-banner-pick') > 0 && end.indexOf('topbar-brand') > end.indexOf('store-banner-pick'), 'the picker, then "AP Control" (leftmost in RTL)');
  const desk = css.slice(css.indexOf('@media (min-width: 1000px) {\n  .topbar {'));
  assert.ok(desk.length > 100, 'a desktop header-row block exists');
  assert.match(desk, /position: fixed; top: 0;[^}]*inset-inline-start: 250px; inset-inline-end: 0;/, 'over the content area only — the sidebar keeps its full height');
  assert.match(desk, /grid-template-columns: minmax\(max-content, 1fr\) minmax\(0, auto\) minmax\(max-content, 1fr\);/, 'equal sides → the name is centred over the page');
  assert.match(desk, /\.sb-start \{ justify-self: start; margin-inline-start: calc\(max\(0px, \(100cqw - 1120px\) \/ 2\) \+ var\(--space-6\) - 18px\); \}/, 'right group edge = the first tile right edge');
  assert.match(desk, /body:has\(\.topbar\) main\.page \.h1-in-header \{ display: none; \}/, 'the page h1 is not repeated on desktop either');
  assert.match(css, /main\.page \.page-back \{ text-align: start !important; \}/);
  assert.match(css, /@media print \{\n  \.topbar \{ display: none !important; \}\n  main\.page \.h1-in-header \{ display: block !important; \}/, 'a printed page keeps its title');
});

test('phone: the page name sits in the centre of the header row and the page h1 is not repeated (owner, 17/10)', () => {
  const header = readFileSync(new URL('../src/views/partials/header.ejs', import.meta.url), 'utf8');
  assert.match(header, /<span class="nav-title">/);
  assert.match(header, /document\.querySelectorAll\('\.nav-title, \.topbar-title'\)\.forEach\(function \(t\) \{ t\.textContent = name;/);
  assert.match(header, /h\.classList\.add\('h1-in-header'\);/);
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

test('phone: the menu button reads "AP Control" and sits on the right, where the logo was; the page name stays centred (owner, 18/10)', () => {
  const header = readFileSync(new URL('../src/views/partials/header.ejs', import.meta.url), 'utf8');
  assert.doesNotMatch(header, /☰ ניווט דפים/);
  assert.match(header, /<summary class="btn btn-secondary btn-sm" aria-label="ניווט דפים"[^>]*><span class="nav-brand navmenu-brand"><span class="mark">AP<\/span>Control<\/span> <span class="caret">▾<\/span><\/summary>/);
  const phone = css.slice(css.indexOf('@media (max-width: 999.98px) {\n  .topbar {'));
  assert.match(phone, /\.nav \{ display: grid; grid-template-columns: minmax\(max-content, 1fr\) minmax\(0, auto\) minmax\(max-content, 1fr\); column-gap: 8px; \}/, 'equal sides → the page name stays centred');
  assert.match(phone, /\.nav > \.nav-brand \{ display: none; \}/, 'no second logo');
  assert.match(phone, /\.navmenu \{ grid-column: 1; grid-row: 1; justify-self: start; \}/, 'first column = the right side in RTL');
  assert.match(phone, /\.navmenu > \.menu-panel \{ inset-inline-start: 0; inset-inline-end: auto; \}/, 'opens inward, not off the screen');
});

test('phone: the store picker is the leftmost item of the nav row — the same element, moved, never a copy (owner, 18/10)', () => {
  const header = readFileSync(new URL('../src/views/partials/header.ejs', import.meta.url), 'utf8');
  assert.match(header, /<span class="nav-store"><\/span>/, 'a slot in the nav row');
  assert.match(header, /<span class="sb-store">/, 'the store part of the header row is one movable block');
  assert.match(header, /if \(mq\.matches\) \{ if \(store\.parentNode !== slot\) slot\.appendChild\(store\); \}\n\s*else if \(store\.parentNode !== home\) home\.insertBefore\(store, home\.firstChild\);/, 'phone ↔ desktop, both ways');
  assert.equal((header.match(/<select name="store_id" class="store-banner-pick"/g) || []).length, 1, 'one picker in the markup');
  const phone = css.slice(css.indexOf('@media (max-width: 999.98px) {\n  .topbar {'));
  assert.match(phone, /\.nav-store \{ grid-column: 3; grid-row: 1; justify-self: end;/, 'last column, end = the far left in RTL');
  assert.match(phone, /\.topbar:not\(:has\(\.sb-start > \*\)\):not\(:has\(\.sb-store\)\) \{ display: none; \}/, 'an empty bar is not drawn');
});
