// סדר התפריט — נקבע ע"י הבעלים, ולכן נעול.
//
// הסדר אינו קישוט: הוא מקבץ לפי תחום (בנק ליד בנק, ספקים ליד עובדים) ומשקף איך עובדים בפועל.
// בלי הטסט הזה, כל תוספת של דף חדש נוטה להידחף לסוף הרשימה ולפרק את הקיבוץ.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const header = fs.readFileSync(path.join(process.cwd(), 'src/views/partials/header.ejs'), 'utf8');
const at = (key) => {
  const i = header.indexOf(`nav('${key}')`);
  assert.ok(i > 0, `${key} is missing from the nav`);
  return i;
};

test('the bank block runs recon → transfers → voided checks → journal', () => {
  assert.ok(at('nav_reconciliation') < at('nav_transfers'));
  assert.ok(at('nav_transfers') < at('nav_voided_checks'));
  assert.ok(at('nav_voided_checks') < at('nav_audit'));
});

test('suppliers → employees → profitability', () => {
  assert.ok(at('nav_audit') < at('nav_suppliers'), 'the bank block comes first');
  assert.ok(at('nav_suppliers') < at('nav_employees'));
  assert.ok(at('nav_employees') < at('nav_profitability'));
});

test('the tracked-invoices page sits with invoices, where it belongs', () => {
  assert.ok(at('nav_invoices') < at('nav_tracked_invoices'));
  assert.ok(at('nav_tracked_invoices') < at('nav_payments'));
});

test('scan sits at the bottom, immediately above settings', () => {
  assert.ok(at('nav_profitability') < at('nav_scan'), 'not near the top any more');
  assert.ok(at('nav_scan') < header.indexOf("can('settings')"));
});
