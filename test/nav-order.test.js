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

// בעלים 22/10 — "קבוצות + 3 איחודים": לוח בקרה והתיבות של הבעלים, ואז ספקים וחשבוניות · תשלומים ובנק · קופה ·
// צוות · דוחות · הגדרות. "מעוקבות" / "בחוץ" / "מבוטלים" הם תת-קישורים מתחת לפריט ("בתפריט הצד, מתחת לפריט").
const pos = (s) => { const i = header.indexOf(s); assert.ok(i > 0, `${s} is missing from the nav`); return i; };

test('the groups run in the owner\'s order, each under its heading', () => {
  const order = ["navGroup('ספקים וחשבוניות'", "navGroup('תשלומים ובנק'", "navGroup('קופה'", "navGroup('צוות'", "navGroup('דוחות'", '<a href="/settings" '];
  for (let k = 1; k < order.length; k += 1) assert.ok(pos(order[k - 1]) < pos(order[k]), `${order[k - 1]} before ${order[k]}`);
  assert.ok(at('nav_dashboard') < pos('href="/notifications"') && pos('href="/notifications"') < pos('href="/approvals"'), 'dashboard, then the owner\'s inboxes');
  assert.ok(pos('href="/approvals"') < pos("navGroup('ספקים וחשבוניות'"));
});

test('inside the groups: invoices → suppliers → scan; מרקורים → transfers → recon; סגירת Z → דוחות Z; profitability → journal', () => {
  const g = (a, b) => assert.ok(pos(a) < pos(b), `${a} before ${b}`);
  g("['nav_invoices', '/invoices'", "nav('nav_suppliers')"); g("nav('nav_suppliers')", "nav('nav_scan')");
  g("['nav_payments', '/payments'", "nav('nav_transfers')"); g("nav('nav_transfers')", "nav('nav_reconciliation')");
  g("nav('nav_zclosing')", "nav('nav_zreports')");
  g("nav('nav_profitability')", "nav('nav_audit')");
});

test('three pages became sub-links, not menu items; scan shows only when unlocked', () => {
  assert.match(header, /\['nav_invoices', '\/invoices', 'הכל'\], \['nav_tracked_invoices', '\/tracked-invoices', 'מעוקבות'\]/);
  assert.match(header, /\['nav_payments', '\/payments', 'הכל'\], \['nav_outstanding', '\/reports\/outstanding', 'בחוץ'\], \['nav_voided_checks', '\/voided-checks', 'מבוטלים'\]/);
  assert.doesNotMatch(header, />מעוקבות לתשלום</);
  assert.doesNotMatch(header, /<span class="mi-ic">📤<\/span>צ׳קים בחוץ/);
  assert.doesNotMatch(header, /<span class="mi-ic">🚫<\/span>צ׳קים מבוטלים/);
  assert.match(header, /<% if \(_scanOn && nav\('nav_scan'\)\) \{ %>/);
});

// בעלים 21/10: "📖 מדריך למשתמש" — "לשים מעל לוח הבקרה".
test('the user guide is the first link, above the dashboard', () => {
  assert.ok(header.indexOf('<a href="/settings/guide"') > 0);
  assert.ok(header.indexOf('<a href="/settings/guide"') < at('nav_dashboard'));
});
