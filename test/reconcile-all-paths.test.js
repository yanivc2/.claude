import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { reconcileAccount } from '../src/services/reconciliation.js';

// 🔴 `reconcileDeposits` נקרא בעבר **רק** מכפתור "התאמה אוטומטית" בדף המרקורים. לא מדף התאמת
// הבנק (שם כפתור באותו שם עשה רק צ׳קים), לא ממשיכת הבנקאות הפתוחה ולא מהסריקה הלילית. כלומר
// הפקדה נקשרה לשורת הבנק שלה רק אם הבעלים במקרה לחץ על הכפתור הנכון מבין השניים — ומי שלחץ על
// השני קיבל "הותאמו 0" בלי שום רמז למה. `reconcileAccount` הוא הביטוי היחיד: צ׳קים וגם הפקדות.

test('reconcileAccount מתאים גם צ׳ק וגם הפקדה בקריאה אחת', async () => {
  const x = await freshDb();
  const ow = await owner(x); const store = await firstStore(x); const acc = await accountForStore(x, store.id);
  await x.run(`INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
               VALUES (?, '2026-09-05', 100000, 'הפ.תיק ממסרים', '4242', 'csv')`, [acc.id]);
  const dep = await x.run(`INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, created_by)
                           VALUES (?, '2026-09-05', '4242', 100000, 0, ?)`, [store.id, ow.id]);

  const r = await reconcileAccount(acc.id, ow, x);
  assert.equal(r.deposits, 1, 'ההפקדה הותאמה');
  assert.ok('matched' in r && 'ambiguous' in r && 'unmatched' in r, 'שדות autoReconcile נשמרו לקוראים ותיקים');
  const row = await x.one('SELECT matched_txn_id FROM deposits WHERE id = ?', [dep.lastInsertRowid]);
  assert.ok(row.matched_txn_id);
});

test('🔴 כל מסלול שמייבא תנועות בנק קורא ל-reconcileAccount, לא ל-autoReconcile לבדו', () => {
  // סריקה על הקוד: `autoReconcile` הוא התאמת צ׳קים בלבד. מי שקורא לו ישירות מחוץ לשירות
  // ההתאמה עצמו מתאים חצי — ומשאיר כל הפקדה תלויה באוויר.
  const ROOT = path.join(process.cwd(), 'src');
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir)) {
      const f = path.join(dir, e);
      if (statSync(f).isDirectory()) walk(f, out);
      else if (e.endsWith('.js')) out.push(f);
    }
    return out;
  };
  const offenders = [];
  for (const f of walk(ROOT)) {
    if (f.endsWith(path.join('services', 'reconciliation.js'))) continue; // שם הוא מוגדר ונקרא כדין
    const src = readFileSync(f, 'utf8');
    if (/\bautoReconcile\s*\(/.test(src)) offenders.push(path.relative(ROOT, f));
  }
  assert.deepEqual(offenders, [], 'להשתמש ב-reconcileAccount — צ׳קים וגם הפקדות');
});
