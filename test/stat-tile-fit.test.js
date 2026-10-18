// בעלים, 17/10: "בלוח הבקרה בסלולרי, בצ׳קים בחוץ הכתב יצא מהרובריקה — שלא ייצא בשום רובריקה".
// נמדד בדפדפן: ב-430px האריחים שניים בשורה ו-"₪184,500.03" ב-28px רחב מהאריח. התיקון: מספר בשורה אחת
// שמתכווץ רק כשאינו נכנס (מספר קצר נשאר בגודל מלא), ותווית ארוכה נשברת.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');

test('every tile: may shrink in the grid, labels wrap, the number stays on one line', () => {
  assert.match(css, /\.stat \{ min-width: 0; overflow-wrap: anywhere; \}/);
  assert.match(css, /\.stat \.num, \.stat \.value \{ white-space: nowrap; overflow-wrap: normal; \}/);
});

test('the number shrinks only while it overflows its tile, from its own starting size', () => {
  assert.match(footer, /document\.querySelectorAll\('\.stat \.num, \.stat \.value'\)/);
  assert.match(footer, /while \(el\.scrollWidth > el\.clientWidth \+ 1 && size > 13\)/);
  assert.match(footer, /el\.dataset\.fs0 = el\.style\.fontSize \|\| ''/, 'an inline size (22px date) is the start, not lost');
  assert.match(footer, /window\.addEventListener\('resize', fit\)/);
});
