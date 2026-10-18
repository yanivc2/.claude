// בעלים, 16/10: "תמרכז הכל" — כל הכתב בתוכן הדף ובסרגל הניווט ממורכז, בכל דף.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');

test('all page text is centered, overriding local alignment', () => {
  assert.match(css, /main\.page, main\.page \* \{ text-align: center !important; \}/);
  assert.match(css, /main\.page \.toolbar,[\s\S]*?\{ justify-content: center !important; \}/);
});

test('sidebar: icons in one straight column near the middle, labels run left from them; logo on the left', () => {
  assert.match(css, /justify-content: flex-start; text-align: start;\n  padding-inline-start: max\(12px, calc\(\(100% - var\(--nav-w, 170px\)\) \/ 2\)\);/);
  assert.match(css, /@media \(min-width: 1000px\) \{ \.nav-brand \{ justify-content: flex-start; \} \}/);
  const header = readFileSync(new URL('../src/views/partials/header.ejs', import.meta.url), 'utf8');
  assert.match(header, /panel\.style\.setProperty\('--nav-w', Math\.ceil\(max\) \+ 'px'\);/, 'the group width is measured, not guessed');
});

test('the header row is centred too — the store picker shows its name in the middle; the sidebar is untouched (owner, 18/10)', () => {
  assert.match(css, /\.topbar, \.topbar \* \{ text-align: center !important; \}/, '.topbar sits outside <main>, so it is named explicitly');
  assert.match(css, /main\.page select, \.topbar select \{ text-align-last: center; \}/, 'a select aligns its shown value by text-align-last');
  assert.doesNotMatch(css, /\.nav[^{]*\{[^}]*text-align: center !important/, 'the sidebar keeps its own alignment');
  const desk = css.slice(css.indexOf('@media (min-width: 1000px) {\n  .topbar {'));
  assert.match(desk, /\.topbar \.store-banner-quick > \.menu-panel \{ inset-inline-start: 0; inset-inline-end: auto; \}/, '"אפשרויות" opens inward, not over the sidebar');
});
