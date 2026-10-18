// "הוסף שטרות" / "החסר שטרות" בספירת המזומן (public/count-adjust.js).
//
// המצב: סופרים 15 שטרות של ₪200, ואז מגיעה עוד חבילה עם 20. בלי זה צריך לחשב 35 בראש ולהקליד
// מחדש — וכל טעות בחיבור הזה הופכת לפער מזומן שמישהו יחפש אחר כך.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');
const js = read('src/public/count-adjust.js');

test('it drives the same inputs the totals already listen to', () => {
  // The quantity fields carry data-val (the denomination) — keying on that is what lets one
  // implementation serve the drawer count AND every register block.
  assert.match(js, /querySelectorAll\('input\[data-val\]'\)/);
  // Setting .value alone would leave every subtotal stale; the existing recalc listens for `input`.
  assert.match(js, /dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\)/);
});

test('subtracting below zero floors at zero and says so', () => {
  assert.match(js, /Math\.max\(0, before - n\)/, 'a negative count of notes is not a state that exists');
  assert.match(js, /היו רק/, 'and the user is told what actually happened');
});

test('a quantity of zero or nonsense is refused, not silently applied', () => {
  assert.match(js, /!Number\.isFinite\(n\) \|\| n <= 0/);
});

test('both closing screens mark their count tables, including a register added after load', () => {
  for (const p of ['src/views/zclosing/index.ejs', 'src/views/zclosing/edit.ejs']) {
    const v = read(p);
    assert.equal((v.match(/data-count-adjust/g) || []).length, 2,
      `${p}: the drawer table and the register-block template`);
    assert.match(v, /if \(window\.apCountAdjust\) window\.apCountAdjust\(div\)/,
      `${p}: a register added after load must get the buttons too`);
    assert.match(v, /<script src="\/count-adjust\.js" defer><\/script>/, `${p}: the script is loaded`);
  }
});

// בעלים 18/10 ("תמחוק", צילומים של סגירת Z): טבלת ספירה היא טבלת הזנה — בלי "חיפוש בטבלה…" ובלי
// שורת "סנן…"; ובטופס החדש אין שדה חנות גלוי ואין שורת "תחילת ספירה" (שניהם נשלחים נסתרים).
test('closing screens: count tables have no search / filter row; the new form shows no store field or start time', () => {
  for (const p of ['src/views/zclosing/index.ejs', 'src/views/zclosing/edit.ejs']) {
    const v = read(p);
    assert.equal((v.match(/<table class="no-search no-filter" data-count-adjust>/g) || []).length, 2, p);
  }
  const v = read('src/views/zclosing/index.ejs').replace(/<%#[\s\S]*?%>/g, '');
  assert.doesNotMatch(v, /תחילת ספירה:/);
  assert.match(v, /<input type="hidden" name="started_at" value="<%= startedAt %>" \/>/, 'still sent');
  assert.match(v, /include\('\.\.\/partials\/_formStore', \{ label: false \}\)/, 'store_id + ctx_store still sent, no visible field');
  assert.doesNotMatch(v, /include\('\.\.\/partials\/_formStore'\)/);
});

// בעלים 18/10: "שים את רובריקת עובד מבצע הספירה מימין למספר Z ותקטין אותם באופן שווה שיתאימו לשורה.
// מתחת לזה תעביר את איזון קופות. את כפתורי הוספת השטרות שים מימין ושמאל לכמות. ומחק את 'ספירת
// מזומן' ושנה את 'הזנת סגירת Z חדשה' ל'סגירת Z (קופות)'".
test('closing form: counter · Z number · drawer cash in one equal row, then איזון קופות, no "ספירת מזומן" title', () => {
  const v = read('src/views/zclosing/index.ejs').replace(/<%#[\s\S]*?%>/g, '');
  assert.match(v, /<summary>סגירת Z \(קופות\)<\/summary>/);
  assert.doesNotMatch(v, /הזנת סגירת Z חדשה/);
  assert.doesNotMatch(v, /<h3[^>]*>ספירת מזומן<\/h3>/);
  const row = v.slice(v.indexOf('<div class="row zc-top-row">'), v.indexOf('איזון קופות (ספירת'));
  const at = (t) => row.indexOf(t);
  assert.ok(at('עובד (מבצע הספירה)') > 0 && at('עובד (מבצע הספירה)') < at('מספר Z') && at('מספר Z') < at('סה"כ מזומן מגירה'),
    'counter first (= right in RTL), then Z number, then drawer cash — and all before איזון קופות');
  const css = read('src/public/nocturne.css');
  assert.match(css, /\.zc-top-row > div \{ flex: 1 1 0; min-width: 0;/);
});

test('±bills buttons sit in the כמות header: ➕ right of it, ➖ left of it; the export still says "כמות"', () => {
  assert.match(js, /head\.appendChild\(add\); head\.appendChild\(name\); head\.appendChild\(sub\);/);
  assert.match(js, /th\.setAttribute\('data-export-text', label\);/);
  const footer = read('src/views/partials/footer.ejs');
  assert.match(footer, /if \(cell && cell\.hasAttribute\('data-export-text'\)\) return cell\.getAttribute\('data-export-text'\);/);
});
