// בעלים 17/11 (חלון "התאם" של ₪6,790 "מוצרי איכות קנדיים", שהציג גם את "מוצרי איכות אמריקאיים"): "תציג קודם כל
// ספק שיש התאמה לשם שלו בהוצאה, ככל שההתאמה יותר טובה כך זה יופיע יותר קרוב". לא מסתירים התאמה חלקית —
// מסדרים: השם כולו לפני חלק ממנו, ובתוך כל ספק הסכום הקרוב ביותר.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mentionScore, suppliersMentioned, rankInvoices } from '../src/lib/cashInvoiceMatch.js';

const E = { amount: 679000, payer_name: 'רון דמי', purpose: 'מוצרי איכות קנדיים', expense_date: '2026-10-26' };

test('the score: the whole name 1, part of it less, a name not mentioned 0; בע"מ is not a word of the name', () => {
  assert.equal(mentionScore(E, 'מוצרי איכות קנדיים'), 1);
  assert.equal(mentionScore(E, 'מוצרי איכות אמריקאיים'), 2 / 3);
  assert.equal(mentionScore(E, 'מוצרי איכות אמריקאיים בע"מ'), 2 / 3, 'בע"מ neither helps nor hurts');
  assert.equal(mentionScore(E, 'מוצרי איכות קנדיים בע"מ'), 1);
  assert.equal(mentionScore(E, 'תנובה'), 0);
  assert.equal(mentionScore({ payer_name: 'טרה', purpose: 'וקוקה קולה' }, 'קוקה קולה ישראל'), 2 / 3, 'Hebrew prefix still counts');
});

test('the supplier lines in the dialog: the best match first, whatever the order of the supplier list', () => {
  const names = ['מוצרי איכות אמריקאיים', 'מוצרי איכות אמריקאיים בע"מ', 'תנובה', 'מוצרי איכות קנדיים'];
  assert.deepEqual(suppliersMentioned(E, names), ['מוצרי איכות קנדיים', 'מוצרי איכות אמריקאיים', 'מוצרי איכות אמריקאיים בע"מ']);
});

test('the list: the named supplier first (closest amount inside), the partial match next, then everyone by closest amount', () => {
  const inv = (id, supplier_name, total_amount, invoice_date = '2026-10-25') => ({ id, supplier_name, total_amount, invoice_date });
  const r = rankInvoices(E, [
    inv(1, 'שטראוס', 690000),
    inv(2, 'תנובה', 650000),
    inv(3, 'מוצרי איכות קנדיים', 1230000),
    inv(4, 'מוצרי איכות קנדיים', 700000),
    inv(5, 'מוצרי איכות אמריקאיים', 116379),
    inv(6, 'טרה', 679000),
  ]);
  assert.deepEqual(r.map((x) => x.id), [4, 3, 5, 6, 1, 2]);
  assert.deepEqual(r.map((x) => x.nameMatch), [true, true, true, false, false, false], '≈ on every named supplier');
});

test('an expense that names no supplier: the closest amount first, as before', () => {
  const r = rankInvoices({ amount: 154170, payer_name: 'זאב', purpose: 'סיגריות' }, [
    { id: 1, supplier_name: 'טרה', total_amount: 900000 },
    { id: 2, supplier_name: 'גלוברנדס', total_amount: 154170 },
    { id: 3, supplier_name: 'תנובה', total_amount: 150000 },
  ]);
  assert.deepEqual(r.map((x) => x.id), [2, 3, 1]);
});
