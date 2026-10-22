import { getExecutor } from '../db/adapter.js';
import { scopeWhere } from '../lib/scope.js';
import { addDaysIso, israelToday } from '../lib/loginHours.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

// "תשלומים לרשויות" בדף הספקים (בעלים 21/10: "תשלומים שיצאו מהבנק"). חיוב בנק לרשות מזוהה מהתיאור שלו
// בדף הבנק — מילים מלאות בלבד, לא ראשי תיבות (מ.ה / ב.ל מופיעים גם בתיאורים אחרים). הראשונה שתואמת קובעת,
// ולכן הספציפיות קודמות ל"רשות המסים" הכללית. "מע"מ" רק כמילה שלמה — לא "מעמד".
const HEB = '\u0590-\u05FF';
export const AUTHORITIES = [
  { key: 'bituach', name: 'ביטוח לאומי', re: /ב[ִי]?טוח\s*לאומי/ },
  { key: 'income', name: 'מס הכנסה', re: /מס[\s-]*הכנסה|פקיד\s*שומה/ },
  { key: 'vat', name: 'מע"מ', re: new RegExp(`(?<![${HEB}])מע["״']?מ(?![${HEB}])`) },
  { key: 'tax', name: 'רשות המסים', re: /רשות\s*המי?סים/ },
  { key: 'city', name: 'ארנונה / עירייה', re: /ארנונה|עיריי?ה|עיריית|מועצה\s*(?:מקומית|אזורית)/ },
];

export function authorityOf(description) {
  const d = String(description || '');
  return AUTHORITIES.find((a) => a.re.test(d)) || null;
}

/** Has "עדכן מסד נתונים" added payments.authority yet? Until then nothing can be marked (CLAUDE.md · probe). */
export async function authorityPaymentsReady(x = getExecutor()) {
  try { await x.one('SELECT authority FROM payments WHERE id = 0', []); return true; } catch { return false; }
}

/**
 * Mark a payment from מרקורים as a payment to an authority (בעלים 21/10: "מדף מרקורים אפשר לסמן תשלומים לרשויות
 * ולהעביר אותן לטבלת רשויות"), or clear the mark (`key` empty → back to מרקורים).
 * A marked payment leaves the מרקורים table and is listed under "תשלומים לרשויות".
 * 🔴 By credit card it is DONE at issuance (בעלים: "תשלום לרשויות מתבצע לרוב בכרטיס אשראי, לכן בהנפקת התשלום
 * בעצם התשלום התבצע") — an issued credit payment is cleared on the spot, dated the payment date; nothing waits
 * for a bank line that will never name the authority. A check/transfer still clears through the bank as usual.
 * Clearing the mark does not undo that: the card was charged either way.
 */
export async function markPaymentAuthority(paymentId, key, actor, x = getExecutor()) {
  const k = String(key || '').trim() || null;
  const a = k ? AUTHORITIES.find((r) => r.key === k) : null;
  if (k && !a) throw new RuleError('VALIDATION', `רשות לא מוכרת: ${k}`);
  const p = await x.one('SELECT id, method, status, payment_date, authority FROM payments WHERE id = ?', [paymentId]);
  if (!p) throw new NotFoundError(`תשלום ${paymentId} לא נמצא`);
  if (p.status === 'voided') throw new RuleError('VALIDATION', 'תשלום מבוטל — לא משייכים לרשות');
  const clearNow = !!a && p.method === 'credit' && p.status === 'issued';
  if (clearNow) {
    await x.run("UPDATE payments SET authority = ?, status = 'cleared', cleared_date = ? WHERE id = ?", [k, p.payment_date, p.id]);
  } else {
    await x.run('UPDATE payments SET authority = ? WHERE id = ?', [k, p.id]);
  }
  await logAction(
    { userId: actor.id, action: 'payment.authority', entityType: 'payment', entityId: p.id, details: { authority: k, was: p.authority || null, clearedNow: clearNow } },
    x,
  );
  return { authority: a, clearedNow: clearNow };
}

/**
 * תשלומים לרשויות ב-N החודשים האחרונים, בחשבונות שבסקופ (חנות פעילה → החשבון שלה בלבד), מקובצים לפי
 * חודש · רשות · חשבון — מהחדש לישן. שני מקורות:
 *  • חיובי בנק שתיאורם מזהה רשות (`authorityOf`);
 *  • תשלומים שסומנו במרקורים (`payments.authority`) — לרוב אשראי, שלא מופיע בבנק בשם הרשות.
 * חיוב בנק שהותאם לתשלום שסומן לרשות נספר פעם אחת — כתשלום.
 * @returns {Promise<Array<{month:string, authority:string, account:string, count:number, total:number,
 *   items:Array<{id:number, txn_date:string, amount:number, raw_reference:string|null, description:string,
 *   source:'bank'|'payment', payment_id?:number}>}>>}
 */
export async function authorityPayments(scope, { months = 12 } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  const since = addDaysIso(israelToday(), -months * 31);
  const marked = (await authorityPaymentsReady(x))
    ? await x.many(
      `SELECT p.id, p.payment_date, p.amount, p.method, p.check_number, p.reference, p.card_last4, p.authority,
              ba.display_name AS account
         FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id
        WHERE p.authority IS NOT NULL AND p.status <> 'voided' AND p.payment_date >= ?${sc.sql}`,
      [since, ...sc.params],
    )
    : [];
  const markedIds = new Set(marked.map((p) => Number(p.id)));
  const rows = await x.many(
    `SELECT bt.id, bt.txn_date, bt.amount, bt.description, bt.raw_reference, bt.matched_payment_id, ba.display_name AS account
       FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.amount < 0 AND bt.txn_date >= ?${sc.sql}
      ORDER BY bt.txn_date DESC, bt.id DESC`,
    [since, ...sc.params],
  );
  const METHOD = { check: 'צ׳ק', cash: 'מזומן', credit: 'אשראי', transfer: 'העברה', batch: 'מקבץ', standing_order: 'הו"ק' };
  const all = [];
  for (const r of rows) {
    if (r.matched_payment_id != null && markedIds.has(Number(r.matched_payment_id))) continue; // counted as the payment
    const a = authorityOf(r.description);
    if (a) all.push({ a, date: r.txn_date, account: r.account, item: { ...r, source: 'bank' } });
  }
  for (const p of marked) {
    const a = AUTHORITIES.find((r) => r.key === p.authority);
    if (!a) continue;
    all.push({
      a, date: p.payment_date, account: p.account,
      item: {
        id: p.id, payment_id: p.id, source: 'payment', txn_date: p.payment_date, amount: -Number(p.amount),
        raw_reference: p.check_number || p.reference || (p.card_last4 ? `****${p.card_last4}` : null),
        description: `מרקורים · ${METHOD[p.method] || p.method}`,
      },
    });
  }
  all.sort((u, v) => (String(v.date).localeCompare(String(u.date))) || (Number(v.item.id) - Number(u.item.id)));
  const groups = new Map();
  for (const { a, date, account, item } of all) {
    const month = String(date).slice(0, 7);
    const k = `${month}|${a.key}|${account}`;
    if (!groups.has(k)) groups.set(k, { month, authority: a.name, account, count: 0, total: 0, items: [] });
    const g = groups.get(k);
    g.count += 1;
    g.total += -Number(item.amount);
    g.items.push(item);
  }
  return [...groups.values()];
}
