// בעלים 17/11 (חלון "התאם"): "כשאני לוחץ על רובריקת החיפוש אני רוצה שיפתח סכומים שהכי קרובים לפי סדר של הסכום
// הקרוב ביותר ולפי המלל המתאים ביותר". בלחיצה — הרשימה בסדר המקורי (בחלון ההתאמה: הסכום הקרוב ראשון,
// rankInvoices); בהקלדה — המתאים ביותר במלל ראשון, ובתוך כל דרגה שוב הסכום הקרוב. ₪ ופסיקים לא נחשבים.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
const combo = footer.slice(footer.indexOf('// Searchable combobox'));
const grab = (name) => {
  const a = combo.indexOf(`function ${name}(`);
  let depth = 0, i = combo.indexOf('{', a);
  for (; i < combo.length; i++) { if (combo[i] === '{') depth++; else if (combo[i] === '}' && --depth === 0) break; }
  return combo.slice(a, i + 1);
};
// eslint-disable-next-line no-new-func
const tier = new Function(`${grab('norm')}\n${grab('normx')}\n${grab('tier')}\nreturn tier;`)();
const order = (labels, q) => labels.map((t, i) => ({ t, i, r: tier(t, q) })).filter((x) => x.r >= 0)
  .sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.t);

// the dialog's list, already closest amount first (₪6,790 paid)
const LIST = [
  'שטראוס #S-7 · ₪6,900.00 · 14/11/26',
  'תנובה #T-1 · ₪6,500.00 · 14/11/26',
  '≈ מוצרי איכות קנדיים #52990 · ₪12,300.00 · 25/10/26',
  'טרה #R-2 · ₪1,200.00 · 14/11/26',
];

test('nothing typed: the list as it came — closest amount first', () => {
  assert.deepEqual(order(LIST, ''), LIST);
});

test('typing an amount finds it without the comma or ₪', () => {
  assert.deepEqual(order(LIST, '6500'), ['תנובה #T-1 · ₪6,500.00 · 14/11/26']);
  assert.deepEqual(order(LIST, '6,500'), ['תנובה #T-1 · ₪6,500.00 · 14/11/26']);
  const r = order(LIST, '₪1,200');
  assert.equal(r[0], 'טרה #R-2 · ₪1,200.00 · 14/11/26', 'the exact amount first');
  assert.deepEqual(r.slice(1), ['≈ מוצרי איכות קנדיים #52990 · ₪12,300.00 · 25/10/26'], 'a loose match (1-2-0-0 in 12,300) only after it');
});

test('the best text match first; a loose "letters in order" match goes last, not mixed in', () => {
  const r = order(['א טרהלה · ₪10.00', 'ט ר ה · ₪20.00', 'טרה #1 · ₪30.00', 'שטרה · ₪5.00'], 'טרה');
  assert.deepEqual(r, ['א טרהלה · ₪10.00', 'טרה #1 · ₪30.00', 'שטרה · ₪5.00', 'ט ר ה · ₪20.00'],
    'word start (טרה, טרהלה) → inside a word (שטרה) → letters in order; ties keep the closest-amount order');
});

test('the combo sorts by that rank and keeps the original order inside it', () => {
  assert.match(combo, /\.sort\(function\(a, b\)\{ return a\.r - b\.r \|\| a\.i - b\.i; \}\)/);
  assert.match(combo, /input\.addEventListener\('focus', function\(\)\{ render\(/, 'a click opens the whole list');
});
