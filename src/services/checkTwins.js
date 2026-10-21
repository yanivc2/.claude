import { getExecutor } from '../db/adapter.js';
import { plainNumber } from '../lib/numText.js';
import { getSetting, setSetting } from './appSettings.js';
import { notify } from '../lib/notify.js';
import { recordNotification } from './notifications.js';

// 🔔 "צ׳ק תאום" בין חשבונות (בעלים 21/10): "כל חשבון חי בעולם משלו — אבל אם מצאת שיש אותם נתונים של מספר
// צ׳ק וסכום, תן התראה על כך בלוח הבקרה ושלח לי פוש שאבדוק". זה בדיוק הסימן של מה שקרה במידנייט: צ׳קים
// 18338/18477 של פינק ו-27463 של על הדרך ישבו גם במידנייט.
//
// מקורות: חיובי בנק של צ׳קים (התיאור "שיק"/"צ׳ק", לא עמלה) וצ׳קים שהונפקו במערכת (לא מבוטלים). אותו מספר
// ואותו סכום ביותר מחשבון אחד = ממצא. כל ממצא מתריע **פעם אחת** (`check_twins_alerted`): פוש + פעמון
// ושורה בכרטיס ההתראות של לוח הבקרה — לכל חנות מעורבת, כדי שמי שעומד בכל אחת מהן יראה.

export const CHECK_TWIN_KIND = 'check_twin';
const SEEN_KEY = 'check_twins_alerted';
const digits = (v) => plainNumber(String(v ?? '').trim()).replace(/\D/g, '').replace(/^0+/, '');
const isCheckRow = (desc) => /שיק|צ['׳]ק|המחא/.test(desc) && !/עמ['׳]|עמלה/.test(desc);
const dmy = (iso) => String(iso || '').slice(0, 10).split('-').reverse().join('/').replace(/^(\d\d\/\d\d\/)\d\d(\d\d)$/, '$1$2');
const ils = (ag) => `₪${(Math.abs(Number(ag)) / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * כל הממצאים הנוכחיים: מספר צ׳ק + סכום שמופיעים ביותר מחשבון בנק אחד.
 * @returns {Promise<Array<{key:string, number:string, amount:number, accounts:Array<{id, name, storeId, seen:string[]}>}>>}
 */
export async function findCheckTwins(x = getExecutor()) {
  const groups = new Map();
  const put = (num, amount, acc, what) => {
    if (num.length < 4 || !amount) return;
    const k = `${num}|${amount}`;
    if (!groups.has(k)) groups.set(k, { number: num, amount, accounts: new Map() });
    const g = groups.get(k);
    if (!g.accounts.has(Number(acc.id))) g.accounts.set(Number(acc.id), { id: Number(acc.id), name: acc.name, storeId: acc.storeId, seen: [] });
    g.accounts.get(Number(acc.id)).seen.push(what);
  };
  const rows = await x.many(
    `SELECT bt.txn_date, bt.amount, bt.raw_reference, bt.description, ba.id AS account_id, ba.display_name, ba.store_id
       FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.amount < 0 AND bt.raw_reference IS NOT NULL`,
    [],
  );
  for (const r of rows) {
    if (!isCheckRow(String(r.description || ''))) continue;
    put(digits(r.raw_reference), Math.abs(Number(r.amount)), { id: r.account_id, name: r.display_name, storeId: r.store_id }, `חיוב בבנק ${dmy(r.txn_date)}`);
  }
  const pays = await x.many(
    `SELECT p.check_number, p.amount, p.payment_date, ba.id AS account_id, ba.display_name, ba.store_id
       FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id
      WHERE p.method = 'check' AND p.check_number IS NOT NULL AND p.status <> 'voided'`,
    [],
  );
  for (const p of pays) {
    put(digits(p.check_number), Math.abs(Number(p.amount)), { id: p.account_id, name: p.display_name, storeId: p.store_id }, `צ׳ק במערכת ${dmy(p.payment_date)}`);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.accounts.size < 2) continue;
    const accounts = [...g.accounts.values()].sort((a, b) => a.id - b.id);
    out.push({ key: `${g.number}|${g.amount}|${accounts.map((a) => a.id).join(',')}`, number: g.number, amount: g.amount, accounts });
  }
  return out;
}

/** מתריע על ממצאים חדשים בלבד. נקרא בסוף כל התאמה (סנכרון / ייבוא / "התאמה אוטומטית"). לא זורק. */
export async function alertCheckTwins(x = getExecutor()) {
  try {
    const found = await findCheckTwins(x);
    if (!found.length) return 0;
    let seen = [];
    try { seen = JSON.parse((await getSetting(SEEN_KEY, '[]', x)) || '[]'); } catch { seen = []; }
    const fresh = found.filter((f) => !seen.includes(f.key));
    for (const f of fresh) await alertOne(f.number, f.amount, f.accounts, x);
    if (fresh.length) await setSetting(SEEN_KEY, JSON.stringify([...seen, ...fresh.map((f) => f.key)].slice(-500)), x);
    return fresh.length;
  } catch {
    return 0;
  }
}

/** שורה של חשבון אחר שהייבוא חסם (חוק הברזל) — גם עליה פוש + לוח בקרה: "שאבדוק". */
export async function alertBlockedForeignRows(foreign, intoAccount, x = getExecutor()) {
  try {
    if (!foreign || !foreign.length) return;
    const acc = await x.one('SELECT id, display_name, store_id FROM bank_accounts WHERE id = ?', [Number(intoAccount)]);
    const lines = foreign.slice(0, 8).map((f) => `• ${f.ref} · ${ils(f.amount)} · ${dmy(f.date)} — רשום ב${f.account}`).join('\n');
    await notify(`⚠️ <b>ייבוא ל${acc ? acc.display_name : 'חשבון'} — ${foreign.length} שורות של חשבון אחר לא נקלטו</b>\n${lines}\nלבדוק לאיזה חשבון הן שייכות.`,
      { kind: CHECK_TWIN_KIND, storeId: acc?.store_id ?? null, link: acc ? `/reconciliation?account=${acc.id}` : '/reconciliation' });
  } catch { /* התראה לא מפילה ייבוא */ }
}

async function alertOne(number, amount, accounts, x) {
  const where = accounts.map((a) => `${a.name} (${a.seen.join(', ')})`).join(' · ');
  const html = `⚠️ <b>צ׳ק ${number} · ${ils(amount)} מופיע בשני חשבונות</b>\n${where}\nלבדוק לאיזה חשבון הוא שייך.`;
  const link = `/reconciliation/integrity?account=${accounts[0].id}`;
  // פוש אחד (טלגרם + פעמון בחנות הראשונה), ושורה בפעמון/לוח של כל חנות נוספת — בלי פוש כפול.
  await notify(html, { kind: CHECK_TWIN_KIND, storeId: accounts[0].storeId, link });
  const [title, ...rest] = html.replace(/<[^>]+>/g, '').split('\n');
  for (const a of accounts.slice(1)) {
    if (a.storeId === accounts[0].storeId) continue;
    await recordNotification({ kind: CHECK_TWIN_KIND, title, body: rest.join('\n'), link, storeId: a.storeId }, x);
  }
}
