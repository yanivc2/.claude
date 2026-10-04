import { getExecutor } from '../db/adapter.js';
import { plainNumber } from '../lib/numText.js';

// בדיקת שיוך לחשבון — "האם כל התנועות בחשבון הזה באמת שלו?"
//
// ייבוא קובץ אינו קורא את מספר החשבון מהקובץ: המשתמש בוחר חשבון ומעלה. קובץ של חנות אחת שנחת
// בחשבון של אחרת כבר קרה, והוא נראה בדיוק כמו הצלחה. שלוש בדיקות, כל אחת מהנתונים עצמם:
//
//  1. **רצף היתרות.** קבצי הבנק נושאים "יתרה לאחר פעולה" לכל שורה (`balance_after`). בחשבון אחד
//     היתרה של כל יום = היתרה של היום הקודם + סכום תנועות היום. שורה של חשבון אחר (או קובץ שלם
//     שלו) שוברת את הרצף. סדר השורות **בתוך** יום אינו ידוע (הבנק והקובץ לא תמיד מסכימים), ולכן
//     הבדיקה יומית: היתרה הצפויה בסוף היום חייבת להופיע באחת משורות היום.
//     שבר יכול לנבוע גם מ**תנועות חסרות** (תקופה שלא יובאה) — הדף אומר את שתי האפשרויות.
//  2. **אותה תנועה בחשבון אחר** — תאריך, סכום, אסמכתה ותיאור זהים: אותו קובץ יובא לשני חשבונות.
//  3. **צ׳ק מפנקס של חשבון אחר** — חיוב שאסמכתתו = מספר צ׳ק שהונפק מחשבון אחר, באותו סכום.

const refKey = (v) => plainNumber(String(v ?? '').trim()).replace(/\D/g, '').replace(/^0+/, '');

/** סוף היום כשאין יתרת פתיחה: יתרה שמתיישבת עם שורות היום (או יתרה אחידה — יתרת סוף יום). */
function anchorClose(rows, sum) {
  const bals = rows.filter((r) => r.balance_after != null);
  if (!bals.length) return null;
  const set = new Set(bals.map((r) => Number(r.balance_after)));
  if (set.size === 1) return Number(bals[0].balance_after);
  for (const r of bals) {
    const close = Number(r.balance_after) - Number(r.amount) + sum;
    if (set.has(close)) return close;
  }
  return Number(bals[bals.length - 1].balance_after);
}

/**
 * @returns {Promise<{rowsTotal, rowsWithBalance, daysChecked, firstDate, lastDate,
 *   breaks: Array<{date, expected, found, diff, files}>, duplicates: Array, foreignChecks: Array}>}
 */
export async function accountIntegrity(bankAccountId, x = getExecutor()) {
  const id = Number(bankAccountId);
  const rows = await x.many(
    `SELECT bt.id, bt.txn_date, bt.amount, bt.description, bt.raw_reference, bt.balance_after, bt.import_id, bt.source,
            bi.file_name
       FROM bank_transactions bt LEFT JOIN bank_imports bi ON bi.id = bt.import_id
      WHERE bt.bank_account_id = ?
      ORDER BY bt.txn_date, bt.id`,
    [id],
  );
  const out = {
    rowsTotal: rows.length,
    rowsWithBalance: rows.filter((r) => r.balance_after != null).length,
    daysChecked: 0,
    firstDate: rows[0]?.txn_date || null,
    lastDate: rows[rows.length - 1]?.txn_date || null,
    breaks: [],
    duplicates: [],
    foreignChecks: [],
  };

  // 1. רצף היתרות, יום אחרי יום.
  const days = [];
  for (const r of rows) {
    const d = String(r.txn_date).slice(0, 10);
    if (!days.length || days[days.length - 1].date !== d) days.push({ date: d, rows: [] });
    days[days.length - 1].rows.push(r);
  }
  let close = null;
  for (const day of days) {
    const sum = day.rows.reduce((n, r) => n + (Number(r.amount) || 0), 0);
    const bals = day.rows.filter((r) => r.balance_after != null).map((r) => Number(r.balance_after));
    if (!bals.length) { if (close != null) close += sum; continue; }
    if (close == null) { close = anchorClose(day.rows, sum); continue; }
    out.daysChecked += 1;
    const expected = close + sum;
    if (bals.includes(expected)) { close = expected; continue; }
    const found = anchorClose(day.rows, sum);
    out.breaks.push({
      date: day.date,
      expected,
      found,
      diff: found - expected,
      files: [...new Set(day.rows.map((r) => r.file_name || (r.source === 'csv' ? 'קובץ' : r.source)).filter(Boolean))],
    });
    close = found;
  }

  if (!rows.length) return out;
  const others = await x.many(
    `SELECT bt.id, bt.bank_account_id, bt.txn_date, bt.amount, bt.description, bt.raw_reference, ba.display_name
       FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.bank_account_id <> ? AND bt.txn_date >= ? AND bt.txn_date <= ?`,
    [id, out.firstDate, out.lastDate],
  );

  // 2. אותה תנועה בדיוק בחשבון אחר.
  const key = (r) => `${String(r.txn_date).slice(0, 10)}|${Number(r.amount)}|${refKey(r.raw_reference)}|${String(r.description || '').trim()}`;
  const otherByKey = new Map();
  for (const o of others) if (refKey(o.raw_reference)) otherByKey.set(key(o), o);
  for (const r of rows) {
    if (!refKey(r.raw_reference)) continue;
    const o = otherByKey.get(key(r));
    if (o) out.duplicates.push({ txn: r, otherAccount: o.display_name });
  }

  // 3. חיוב שהוא צ׳ק מפנקס של חשבון אחר (מספר + סכום).
  const checks = await x.many(
    `SELECT p.id, p.check_number, p.amount, p.bank_account_id, ba.display_name
       FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id
      WHERE p.method = 'check' AND p.check_number IS NOT NULL AND p.bank_account_id <> ?`,
    [id],
  );
  const checkBy = new Map();
  for (const c of checks) checkBy.set(`${refKey(c.check_number)}|${Number(c.amount)}`, c);
  for (const r of rows) {
    if (Number(r.amount) >= 0 || !refKey(r.raw_reference)) continue;
    const c = checkBy.get(`${refKey(r.raw_reference)}|${Math.abs(Number(r.amount))}`);
    if (c) out.foreignChecks.push({ txn: r, checkNumber: c.check_number, paymentId: c.id, otherAccount: c.display_name });
  }
  return out;
}
