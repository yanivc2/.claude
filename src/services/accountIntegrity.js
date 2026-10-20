import { getExecutor } from '../db/adapter.js';
import { plainNumber } from '../lib/numText.js';
import { mismatchedMatchesFor } from './reconciliation.js';

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
//  4. **צ׳ק שהותאם לפי סכום בלבד** — התאמה קיימת שבה מספר הצ׳ק סותר את האסמכתה בבנק
//     (`checkNumberConflict`). ההתאמה האוטומטית לא עושה זאת יותר; זו הרשימה של מה שכבר נעשה.

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

// מה מסביר שבר: (1) שורה אחת בחלון שהסרתה מאפסת את ההפרש; (2) שורות שנקלטו **פעמיים** בחלון (אותו
// סכום ואותה אסמכתא) שהעותקים שלהן יחד מאפסים אותו.
function suspectsFor(windowRows, diff) {
  const single = windowRows.filter((r) => Number(r.amount) === -diff);
  if (single.length) return single.map((r) => pickSuspect(r, 'extra'));
  const groups = new Map();
  for (const r of windowRows) {
    const ref = refKey(r.raw_reference);
    if (!ref) continue;
    const k = `${Number(r.amount)}|${ref}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const extras = [...groups.values()].filter((g) => g.length > 1).flatMap((g) => g.slice(1));
  const sum = extras.reduce((n, r) => n + Number(r.amount), 0);
  return extras.length && sum === -diff ? extras.map((r) => pickSuspect(r, 'twice')) : [];
}
const pickSuspect = (r, why) => ({ id: r.id, date: r.txn_date, amount: r.amount, description: r.description, source: r.source, why });

const MAX_DAYS = 3;
const dayOf = (r) => String(r.txn_date).slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
const daysApart = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);

/**
 * אותה תנועה פעמיים **בשני תאריכים** — כל עותק ביום אחר, ולכן אף חלון לבדו לא רואה שתיים.
 * בעלים (16/10, סופר על הדרך): "תיקון (תאריך ערך 06/09)" ‎-51,920 / ‎+51,905 ועמלת שטרי כסף ‎-22.38
 * נרשמו בבנק ב-07/09, אבל קובץ שיוצא קודם הציג אותן ב-06/09. שני הקבצים יובאו, בדיקת הכפילות בייבוא
 * משווה תאריך — ושתי הגרסאות נכנסו. היום של 06/09 **עבר** את הבדיקה (לעותקים יש יתרה משלהם, והיתרה
 * של העמלה היא בדיוק הצפויה), והשבר כולו הופיע ב-07/09: ‎+37.38. טהור.
 *
 * זוג = אותו סכום ואותה אסמכתא (בלי אסמכתא: אותו תיאור), בתאריכים שונים עד 3 ימים, לא מאותו ייבוא
 * (קובץ אחד לא מציג תנועה פעמיים), ולפחות עותק אחד בחלון השבור. נשארת השורה שנושאת יתרה, אחריה זו
 * עם מזהה בנק (המשיכה הבאה תזהה אותה), ובתיקו — מהייבוא החדש יותר (התמונה העדכנית של הבנק).
 * @returns {Array<{keep, drop}>} רק כשקבוצה **אחת** של עותקים מסתכמת בדיוק ב‎-diff; אחרת [].
 */
export function twiceAcrossDays(rows, brk) {
  const to = brk.date;
  const since = brk.since || brk.date;
  const from = addDays(since, -MAX_DAYS);
  const groups = new Map();
  for (const r of rows) {
    const d = dayOf(r);
    if (d < from || d > to) continue;
    const ref = refKey(r.raw_reference);
    const desc = String(r.description || '').trim();
    if (!ref && !desc) continue;
    const k = `${Number(r.amount)}|${ref ? `r:${ref}` : `d:${desc}`}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const rank = (r) => (r.balance_after != null ? 2 : 0) + (r.external_id != null ? 1 : 0);
  const pairs = [];
  for (const g of groups.values()) {
    if (g.length !== 2) continue;
    const [a, b] = g;
    const [da, db] = [dayOf(a), dayOf(b)];
    if (da === db || daysApart(da, db) > MAX_DAYS) continue;
    if (a.import_id != null && b.import_id != null && Number(a.import_id) === Number(b.import_id)) continue;
    if (!(da > since || db > since) && since !== to) continue;
    let keep = a;
    let drop = b;
    if (rank(b) > rank(a) || (rank(b) === rank(a) && Number(b.import_id || 0) > Number(a.import_id || 0))) [keep, drop] = [b, a];
    pairs.push({ keep, drop });
  }
  if (!pairs.length || pairs.length > 12) return [];
  let hit = null;
  for (let m = 1; m < (1 << pairs.length); m += 1) {
    let s = 0;
    for (let i = 0; i < pairs.length; i += 1) if (m & (1 << i)) s += Number(pairs[i].drop.amount);
    if (s !== -brk.diff) continue;
    if (hit != null) return []; // שני הסברים — לא מנחשים
    hit = m;
  }
  return hit == null ? [] : pairs.filter((_, i) => hit & (1 << i));
}

/** השורות סביב שבר — מה שצריך לראות כדי להבין אותו (מ-3 ימים לפני תחילת החלון ועד יום השבר). */
function rowsAround(rows, since, date) {
  const from = addDays(since || date, -MAX_DAYS);
  return rows.filter((r) => { const d = dayOf(r); return d >= from && d <= date; }).slice(0, 80).map((r) => ({
    id: r.id, date: dayOf(r), amount: r.amount, description: r.description, ref: r.raw_reference, balance: r.balance_after,
    source: r.source, file: r.file_name || null, hasId: r.external_id != null,
  }));
}

/**
 * רצף היתרות של חשבון אחד — פונקציה טהורה, כדי שגם איחוד הכפילויות (services/bankDuplicates.js)
 * יבדוק "מה יקרה אחרי" באותו ביטוי בדיוק.
 *
 * כל יום שיש בו יתרה סוגר **חלון**: כל התנועות מאז יום-היתרה הקודם (כולל ימים בלי יתרה) נסכמות,
 * והיתרה הצפויה = סגירת החלון הקודם + הסכום. `windowOf` = לאיזה יום-יתרה נבדק נספרה כל תנועה
 * (תנועה לפני העוגן הראשון או אחרי היתרה האחרונה אינה בשום חלון נבדק).
 * @param {Array<{id, txn_date, amount, balance_after, file_name?, source?}>} rows ממוינות לפי תאריך
 */
export function balanceBreaks(rows) {
  const days = [];
  for (const r of rows) {
    const d = String(r.txn_date).slice(0, 10);
    if (!days.length || days[days.length - 1].date !== d) days.push({ date: d, rows: [] });
    days[days.length - 1].rows.push(r);
  }
  const breaks = [];
  const windowOf = new Map();
  const partialDays = [];
  let daysChecked = 0;
  let close = null;
  let pending = [];
  let lastBalDate = null; // יום-היתרה הקודם — תחילת החלון של השבר
  for (const day of days) {
    const sum = day.rows.reduce((n, r) => n + (Number(r.amount) || 0), 0);
    const bals = day.rows.filter((r) => r.balance_after != null).map((r) => Number(r.balance_after));
    if (!bals.length) { if (close != null) { close += sum; pending.push(...day.rows); } continue; }
    // 🔴 קובץ שמכיל רק **חלק** מתנועות היום (במידנייט: 66 שורות קובץ מול ~8 תנועות ביום מהסוכן).
    // היתרה שבשורת קובץ היא היתרה **אחרי אותה פעולה** — באמצע היום, לא בסופו — ואת הסדר בתוך היום
    // לא יודעים. השוואה לסוף היום נתנה "שבר" כמעט בכל יום, בהפרשים שמתקזזים מיום ליום, בלי שום
    // תנועה זרה. לכן יום נבדק רק כשכל שורה בלי יתרה היא עותק אפשרי של שורת קובץ מאותו יום (אותו
    // סכום) — זה המצב של כפילות, שעליו האיחוד נשען; אחרת היום לא נבדק, והעוגן מתחיל מחדש אחריו.
    const pool = day.rows.filter((r) => r.balance_after != null).map((r) => Number(r.amount));
    let partial = false;
    for (const r of day.rows) {
      if (r.balance_after != null) continue;
      const i = pool.indexOf(Number(r.amount));
      if (i < 0) { partial = true; break; }
      pool.splice(i, 1);
    }
    if (partial) { partialDays.push(day.date); close = null; pending = []; lastBalDate = null; continue; }
    if (close == null) { close = anchorClose(day.rows, sum); pending = []; lastBalDate = day.date; continue; }
    daysChecked += 1;
    const windowRows = [...pending, ...day.rows];
    for (const r of windowRows) windowOf.set(Number(r.id), day.date);
    pending = [];
    const since = lastBalDate;
    lastBalDate = day.date;
    const expected = close + sum;
    if (bals.includes(expected)) { close = expected; continue; }
    const found = anchorClose(day.rows, sum);
    const diff = found - expected;
    breaks.push({
      date: day.date,
      since,
      expected,
      found,
      diff,
      files: [...new Set(day.rows.map((r) => r.file_name || (r.source === 'csv' ? 'קובץ' : r.source)).filter(Boolean))],
      // מה זה כנראה: שורה בחלון שהסרתה מאפסת את ההפרש (מיותרת אצלנו); שורות שנקלטו פעמיים — באותו
      // חלון או בשני ימים סמוכים (`twiceAcrossDays`); אחרת — חסרה תנועה של diff.
      suspects: (() => {
        const inWindow = suspectsFor(windowRows, diff);
        if (inWindow.length) return inWindow;
        return twiceAcrossDays(rows, { date: day.date, since, diff }).map((p) => pickSuspect(p.drop, 'twice'));
      })(),
      around: rowsAround(rows, since, day.date),
    });
    close = found;
  }
  return { daysChecked, breaks, windowOf, partialDays };
}

/**
 * @returns {Promise<{rowsTotal, rowsWithBalance, daysChecked, firstDate, lastDate,
 *   breaks: Array<{date, expected, found, diff, files}>, duplicates: Array, foreignChecks: Array}>}
 */
export async function accountIntegrity(bankAccountId, x = getExecutor()) {
  const id = Number(bankAccountId);
  const rows = await x.many(
    `SELECT bt.id, bt.txn_date, bt.amount, bt.description, bt.raw_reference, bt.balance_after, bt.import_id, bt.source,
            bt.external_id, bi.file_name
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
    partialDays: [],
    duplicates: [],
    foreignChecks: [],
    mismatchedMatches: [],
  };

  // 1. רצף היתרות, יום אחרי יום.
  const chain = balanceBreaks(rows);
  out.daysChecked = chain.daysChecked;
  out.breaks = chain.breaks;
  out.partialDays = chain.partialDays;

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

  // 4. צ׳ק שהותאם לפי סכום בלבד, כשהמספר בבנק סותר אותו — ההתאמה האוטומטית עשתה את זה עד ·307.
  for (const m of await mismatchedMatchesFor(id, x)) out.mismatchedMatches.push({ txn: m, paymentId: m.payment_id, checkNumber: m.check_number });
  return out;
}
