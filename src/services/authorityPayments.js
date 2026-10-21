import { getExecutor } from '../db/adapter.js';
import { scopeWhere } from '../lib/scope.js';
import { addDaysIso, israelToday } from '../lib/loginHours.js';

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

/**
 * חיובי בנק לרשויות ב-N החודשים האחרונים, בחשבונות שבסקופ (חנות פעילה → החשבון שלה בלבד), מקובצים לפי
 * חודש · רשות · חשבון — מהחדש לישן.
 * @returns {Promise<Array<{month:string, authority:string, account:string, count:number, total:number,
 *   items:Array<{id:number, txn_date:string, amount:number, raw_reference:string|null, description:string}>}>>}
 */
export async function authorityPayments(scope, { months = 12 } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  const since = addDaysIso(israelToday(), -months * 31);
  const rows = await x.many(
    `SELECT bt.id, bt.txn_date, bt.amount, bt.description, bt.raw_reference, ba.display_name AS account
       FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.amount < 0 AND bt.txn_date >= ?${sc.sql}
      ORDER BY bt.txn_date DESC, bt.id DESC`,
    [since, ...sc.params],
  );
  const groups = new Map();
  for (const r of rows) {
    const a = authorityOf(r.description);
    if (!a) continue;
    const month = String(r.txn_date).slice(0, 7);
    const k = `${month}|${a.key}|${r.account}`;
    if (!groups.has(k)) groups.set(k, { month, authority: a.name, account: r.account, count: 0, total: 0, items: [] });
    const g = groups.get(k);
    g.count += 1;
    g.total += -Number(r.amount);
    g.items.push(r);
  }
  return [...groups.values()];
}
