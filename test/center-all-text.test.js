// בעלים, 16/10: "תמרכז הכל" — כל הכתב בתוכן הדף ובסרגל הניווט ממורכז, בכל דף.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');

test('all page text is centered, overriding local alignment', () => {
  assert.match(css, /main\.page, main\.page \* \{ text-align: center !important; \}/);
  assert.match(css, /main\.page \.toolbar,[\s\S]*?\{ justify-content: center !important; \}/);
});

test('the navigation sidebar is centered too (links and its buttons)', () => {
  assert.match(css, /\.navmenu > \.menu-panel a,\s*\n\.navmenu > \.menu-panel button,\s*\n\.navmenu > \.menu-panel form button \{ justify-content: center; text-align: center; \}/);
});
