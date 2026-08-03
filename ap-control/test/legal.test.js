import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';
import { legalLocals } from '../src/lib/legal.js';

// The privacy notice and accessibility statement are public pages. These tests render the EJS
// views with the shared legal locals and assert the required content is present, which also
// verifies the templates compile.

const viewsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'views');

function render(view, locals) {
  return ejs.renderFile(path.join(viewsDir, view), locals);
}

test('privacy notice renders with the group, processors and cross-border section', async () => {
  const html = await render('legal/privacy.ejs', { title: 'הודעת פרטיות', ...legalLocals });
  assert.match(html, /הודעת פרטיות/);
  assert.match(html, /יניב רום יזמות/);
  assert.match(html, /פינק מרקט/);
  assert.match(html, /על הדרך 24/);
  assert.match(html, /העברת מידע לחו"ל/);
  assert.match(html, /Neon/);
  assert.match(html, new RegExp(legalLocals.contactEmail));
  // Nocturne chrome from the shared shell
  assert.match(html, /nocturne\.css/);
  assert.match(html, /Inter/);
  assert.match(html, /Control/);
  assert.match(html, /amb-glow/);
});

test('accessibility statement renders with the standard and coordinator contact', async () => {
  const html = await render('legal/accessibility.ejs', { title: 'הצהרת נגישות', ...legalLocals });
  assert.match(html, /הצהרת נגישות/);
  assert.match(html, /ת"י 5568/);
  assert.match(html, /WCAG/);
  assert.match(html, new RegExp(legalLocals.accessibilityContact));
});
