// איחוד כפילויות בתוך חשבון אחד — אותה תנועה פעמיים: קובץ + משיכה, או שני ערוצי משיכה.
//
// עד 27/09 משיכה מהבנק שחפפה לקובץ שכבר יובא נקלטה שוב (התיאור באתר שונה מזה שבקובץ, ולכן
// בדיקת השדות לא ראתה כפילות). התיקון עצר כפילויות חדשות, אבל הישנות נשארו: במידנייט רצף
// היתרות נשבר ב-25 ימים בין 13/08 ל-17/09, ובכל אחד מהם היו גם שורות קובץ וגם שורות משיכה.
// הכפילויות מנפחות את "לא מותאם" — מכל תנועה כזו עותק אחד מותאם והשני נשאר תלוי.
//
// 🔴 הזיווג לבדו אינו הוכחה: שתי תנועות אמיתיות באותו סכום בהפרש של יום קורות. ההוכחה היא
// **החשבון עצמו** — זוג מוצע לאיחוד רק כשהסרת העותק מאפסת בדיוק את השבר ברצף היתרות של החלון
// שלו (`balanceBreaks`, אותו ביטוי של בדיקת השיוך). חלון שלא מתאזן בדיוק — הזוגות שבו מוצגים
// לבדיקה ידנית ולא מאוחדים. חלון שהיה תקין ונשבר אחרי ההסרה — הזוג פסול.
//
// האיחוד: נשארת **שורת הקובץ** (היא נושאת את היתרה ואת התאריך שהבנק דיווח), היא מקבלת את מזהה
// המשיכה אם יש לו (כך שמשיכה הבאה מזהה אותה ולא מכפילה שוב; שורת משיכה בלי מזהה מזוהה בייבוא לפי
// אותו כלל זיווג — `importTransactions`), וכל מה שהיה קשור לעותק — התאמת תשלום,
// הפקדה, שכר — עובר אליה. זוג ששני חלקיו קשורים לדברים שונים לא מאוחד (`conflict`).
import { getExecutor, tx } from '../db/adapter.js';
import { plainNumber } from '../lib/numText.js';
import { RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';
import { balanceBreaks } from './accountIntegrity.js';

const FILE_SOURCES = new Set(['csv']);
const PULL_SOURCES = new Set(['scraper', 'financy']);
const MAX_DAYS = 3;

const dayDiff = (a, b) => Math.abs((Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / 86_400_000);
const refOf = (v) => plainNumber(String(v ?? '').trim()) || null;

// מזהה סריקה: `scr:<ערוץ>:<חשבון>:<אסמכתא>` ומאז 27/09 גם `:<תאריך>:<סכום>`.
const TAIL_ID = /^scr:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*$/;
const nsOf = (id) => { const m = /^scr:([^:]*):/.exec(String(id || '')); return m ? m[1] : null; };
/** המזהה בלי רכיב התאריך — אותה תנועה שתאריכה השתנה בין משיכות (ראה importTransactions). */
const undated = (id) => { const m = /^(scr:[^:]*:[^:]*:[^:]*):([^:]*):([^:]*)$/.exec(String(id || '')); return m ? `${m[1]}::${m[3]}` : null; };
const datedPart = (id) => { const m = /^scr:[^:]*:[^:]*:[^:]*:([^:]*):[^:]*$/.exec(String(id || '')); return m ? m[1] : null; };

/**
 * הערוץ שמושך היום את החשבון: הערוץ של שורת המשיכה האחרונה שנקלטה במזהה בפורמט הנוכחי. במידנייט
 * עברו שני ערוצים על אותן תנועות — `scr:hapoalim:` (הסורק החיצוני, מ-06/09) ו-`scr:hapoalimBiz:`
 * (הסוכן במחשב המשרד, מ-26/09) — ולכל אחד מזהה אחר לאותה תנועה, ולכן אף אחד מהם לא זיהה את השני.
 */
export function currentNamespace(rows) {
  let best = null;
  for (const r of rows) {
    if (!PULL_SOURCES.has(r.source) || !TAIL_ID.test(String(r.external_id || ''))) continue;
    if (!best || Number(r.import_id || 0) > Number(best.import_id || 0)) best = r;
  }
  return best ? nsOf(best.external_id) : null;
}

/** מזהה שהמשיכה של היום לעולם לא תפיק שוב: פורמט ישן (בלי תאריך+סכום) או ערוץ שכבר לא מושך. */
export function isStaleId(id, current) {
  if (!id || !/^scr:/.test(String(id))) return false;
  return !TAIL_ID.test(String(id)) || (current != null && nsOf(id) !== current);
}

/**
 * זיווג "אותה תנועה פעמיים" באותו חשבון — אותו סכום, עד 3 ימים, תאריך זהה לפני טווח, אסמכתא
 * זהה מועדפת, כל שורה פעם אחת. טהור.
 *
 * **מה נשאר:** שורת קובץ (נושאת יתרה), או שורת משיכה במזהה של הערוץ הנוכחי.
 * **מה נמחק:** רק שורת משיכה בלי יתרה, ורק כזו שהמשיכה הבאה לא תחזיר:
 *   • בלי מזהה (הייבוא מזהה אותה מול שורת הקובץ — `importTransactions`);
 *   • במזהה ישן או של ערוץ אחר (`isStaleId`);
 *   • במזהה נוכחי — רק כשהשורה שנשארת היא שורת קובץ בלי מזהה, שמקבלת אותו (`takeId`).
 * שתי שורות במזהה הערוץ הנוכחי לא מזווגות — אלא אם המזהים זהים פרט לתאריך (אותה תנועה שתאריכה
 * השתנה בין משיכות), ואז העדכני עובר לשורת הקובץ (`replaceId`).
 */
export function pairDuplicates(rows) {
  const cur = currentNamespace(rows);
  const isFile = (r) => FILE_SOURCES.has(r.source);
  const isCurrentPull = (r) => PULL_SOURCES.has(r.source) && r.external_id != null && !isStaleId(r.external_id, cur);
  const keeps = rows.filter((r) => isFile(r) || isCurrentPull(r));
  const drops = rows.filter((r) => PULL_SOURCES.has(r.source) && r.balance_after == null);
  const used = new Set();
  const pairs = [];
  const allowed = (keep, drop) => {
    if (keep.id === drop.id) return null;
    if (drop.external_id == null || isStaleId(drop.external_id, cur)) {
      // עותק שלא יחזור. נשאר: קובץ, או משיכה נוכחית (לא שתי שורות בלי מזהה — אין מי שיעיד).
      if (!isFile(keep) && keep.external_id == null) return null;
      return { takeId: false };
    }
    // העותק נושא מזהה נוכחי: מותר מול שורת קובץ בלי מזהה, שתקבל אותו —
    if (isFile(keep) && keep.external_id == null) return { takeId: true };
    // — או מול שורת קובץ שאומצה במזהה **של אותה תנועה בתאריך אחר** (התאריך השתנה בין משיכות). העותק
    // נקלט אחרי האימוץ, ולכן המזהה שלו הוא העדכני: הוא מחליף את זה של שורת הקובץ.
    if (isFile(keep) && keep.external_id != null && undated(keep.external_id) != null
      && undated(keep.external_id) === undated(drop.external_id) && datedPart(keep.external_id) !== datedPart(drop.external_id)) {
      return { takeId: true, replaceId: true };
    }
    return null;
  };
  for (const maxDays of [0, MAX_DAYS]) {
    for (const drop of drops) {
      if (used.has(drop.id)) continue;
      const ref = refOf(drop.raw_reference);
      let best = null;
      let bestScore = Infinity;
      for (const keep of keeps) {
        if (used.has(keep.id) || Number(keep.amount) !== Number(drop.amount)) continue;
        const ok = allowed(keep, drop);
        if (!ok) continue;
        const d = dayDiff(keep.txn_date, drop.txn_date);
        if (!(d <= maxDays)) continue;
        // שורת קובץ קודמת למשיכה נוכחית כשיש שתיהן: היא נושאת את היתרה.
        const score = d + (ref && refOf(keep.raw_reference) === ref ? -10 : 0) + (isFile(keep) ? -0.5 : 0);
        if (score < bestScore) { best = { keep, ...ok }; bestScore = score; }
      }
      if (best) {
        used.add(drop.id);
        used.add(best.keep.id);
        pairs.push({ keep: best.keep, drop, takeId: best.takeId, replaceId: !!best.replaceId });
      }
    }
  }
  return pairs;
}

/**
 * אילו זוגות **הוכחו** ככפילות ע"י רצף היתרות. טהור.
 * @returns {Array<{keep, drop, window:string|null, verified:boolean, reason:string|null}>}
 */
export function verifyPairs(rows, pairs) {
  const before = balanceBreaks(rows);
  const dropIds = new Set(pairs.map((p) => Number(p.drop.id)));
  const after = balanceBreaks(rows.filter((r) => !dropIds.has(Number(r.id))));
  const brokeBefore = new Set(before.breaks.map((b) => b.date));
  const brokeAfter = new Set(after.breaks.map((b) => b.date));
  return pairs.map((p) => {
    const w = before.windowOf.get(Number(p.drop.id)) || null;
    let reason = null;
    if (!w) reason = 'מחוץ לימים שיש להם יתרה — אי אפשר לאמת';
    else if (!brokeBefore.has(w) && brokeAfter.has(w)) reason = 'היום היה תקין, והסרת העותק הייתה שוברת אותו';
    else if (!brokeBefore.has(w)) reason = 'היום תקין גם עם שתי השורות — כנראה שתי תנועות שונות';
    else if (brokeAfter.has(w)) reason = 'ההסרה לא מאזנת את היום בדיוק';
    return { ...p, window: w, verified: !reason, reason };
  });
}

async function loadRows(accountId, x) {
  return x.many(
    `SELECT bt.id, bt.txn_date, bt.amount, bt.description, bt.raw_reference, bt.balance_after, bt.source,
            bt.external_id, bt.matched_payment_id, bt.import_id, bi.file_name
       FROM bank_transactions bt LEFT JOIN bank_imports bi ON bi.id = bt.import_id
      WHERE bt.bank_account_id = ?
      ORDER BY bt.txn_date, bt.id`,
    [Number(accountId)],
  );
}

async function salaryLinksReady(x) {
  const { salaryBankReady } = await import('./salaryPayments.js');
  return salaryBankReady(x);
}

/** מה קשור לכל שורה: תשלום (על השורה), הפקדות, שכר. */
async function linksFor(ids, x) {
  const want = new Set(ids.map(Number));
  const deposits = new Map();
  for (const d of await x.many('SELECT id, matched_txn_id FROM deposits WHERE matched_txn_id IS NOT NULL', [])) {
    const k = Number(d.matched_txn_id);
    if (want.has(k)) deposits.set(k, (deposits.get(k) || 0) + 1);
  }
  const salary = new Map();
  if (await salaryLinksReady(x)) {
    for (const s of await x.many('SELECT id, bank_txn_id FROM salary_payments WHERE bank_txn_id IS NOT NULL', [])) {
      const k = Number(s.bank_txn_id);
      if (want.has(k)) salary.set(k, (salary.get(k) || 0) + 1);
    }
  }
  return { deposits, salary };
}

/**
 * הצעת האיחוד לחשבון: כל הזוגות, אילו אומתו, אילו מתנגשים, וכמה שברים יישארו אחרי האיחוד.
 */
export async function findAccountDuplicates(accountId, x = getExecutor()) {
  const rows = await loadRows(accountId, x);
  const checked = verifyPairs(rows, pairDuplicates(rows));
  const links = await linksFor(checked.flatMap((p) => [p.keep.id, p.drop.id]), x);
  for (const p of checked) {
    const k = Number(p.keep.id);
    const d = Number(p.drop.id);
    const bothPaid = p.keep.matched_payment_id != null && p.drop.matched_payment_id != null
      && Number(p.keep.matched_payment_id) !== Number(p.drop.matched_payment_id);
    const bothDep = links.deposits.has(k) && links.deposits.has(d);
    const bothSal = links.salary.has(k) && links.salary.has(d);
    p.conflict = bothPaid ? 'שתי השורות מותאמות לתשלומים שונים'
      : bothDep ? 'שתי השורות מותאמות להפקדות'
        : bothSal ? 'שתי השורות מקושרות לשכר' : null;
    p.dropMatched = p.drop.matched_payment_id != null || links.deposits.has(d) || links.salary.has(d);
  }
  const mergeable = checked.filter((p) => p.verified && !p.conflict);
  const dropIds = new Set(mergeable.map((p) => Number(p.drop.id)));
  return {
    fileRows: rows.filter((r) => FILE_SOURCES.has(r.source)).length,
    fileWithId: rows.filter((r) => FILE_SOURCES.has(r.source) && r.external_id != null).length,
    pulledRows: rows.filter((r) => PULL_SOURCES.has(r.source)).length,
    pulledNoId: rows.filter((r) => PULL_SOURCES.has(r.source) && r.external_id == null).length,
    pulledWithBalance: rows.filter((r) => PULL_SOURCES.has(r.source) && r.balance_after != null).length,
    // לפי ערוץ — שני ערוצים על אותן תנועות הם המקור הנפוץ לכפילות שאף ערוץ לא מזהה.
    channels: (() => {
      const cur = currentNamespace(rows);
      const m = new Map();
      for (const r of rows) {
        if (!PULL_SOURCES.has(r.source)) continue;
        const ns = r.external_id == null ? 'בלי מזהה' : (nsOf(r.external_id) || r.source);
        const key = ns + (r.external_id && !TAIL_ID.test(String(r.external_id)) && /^scr:/.test(String(r.external_id)) ? ' (פורמט ישן)' : '')
          + (ns === cur ? ' — הנוכחי' : '');
        m.set(key, (m.get(key) || 0) + 1);
      }
      return [...m.entries()].map(([name, n]) => ({ name, n }));
    })(),
    pairs: checked,
    mergeable,
    breaksBefore: balanceBreaks(rows).breaks.length,
    breaksAfter: balanceBreaks(rows.filter((r) => !dropIds.has(Number(r.id)))).breaks.length,
  };
}

/**
 * מאחד את כל הזוגות שאומתו ואינם מתנגשים. מחושב מחדש בשרת — שום מזהה לא מגיע מהטופס.
 * @returns {Promise<{merged:number, movedLinks:number}>}
 */
export async function mergeAccountDuplicates(accountId, actor, x = getExecutor()) {
  const { mergeable } = await findAccountDuplicates(accountId, x);
  if (!mergeable.length) throw new RuleError('VALIDATION', 'אין כפילויות מאומתות לאיחוד בחשבון הזה.');
  const withSalary = await salaryLinksReady(x); // לפני הטרנזקציה: probe שנכשל בתוכה מבטל אותה ב-PG
  let movedLinks = 0;
  let merged = 0;
  await tx(async (t) => {
    for (const p of mergeable) {
      const keep = Number(p.keep.id);
      const drop = Number(p.drop.id);
      // הבדיקה חוזרת בתוך הטרנזקציה: שתי השורות עדיין קיימות, באותו חשבון ובאותו סכום.
      const cur = await t.many('SELECT id, amount, bank_account_id, external_id, matched_payment_id FROM bank_transactions WHERE id IN (?, ?)', [keep, drop]);
      const k = cur.find((r) => Number(r.id) === keep);
      const d = cur.find((r) => Number(r.id) === drop);
      if (!k || !d || Number(k.amount) !== Number(d.amount) || Number(k.bank_account_id) !== Number(accountId)
        || Number(d.bank_account_id) !== Number(accountId)) continue;
      if (p.takeId && !p.replaceId && k.external_id != null) continue; // השורה כבר קיבלה מזהה בינתיים — לא נוגעים
      if (d.matched_payment_id != null && k.matched_payment_id == null) {
        await t.run('UPDATE bank_transactions SET matched_payment_id = NULL WHERE id = ?', [drop]);
        await t.run('UPDATE bank_transactions SET matched_payment_id = ? WHERE id = ?', [d.matched_payment_id, keep]);
        movedLinks += 1;
      }
      const dep = await t.many('SELECT id FROM deposits WHERE matched_txn_id = ?', [drop]);
      if (dep.length) { await t.run('UPDATE deposits SET matched_txn_id = ? WHERE matched_txn_id = ?', [keep, drop]); movedLinks += dep.length; }
      if (withSalary) {
        const sal = await t.many('SELECT id FROM salary_payments WHERE bank_txn_id = ?', [drop]);
        if (sal.length) { await t.run('UPDATE salary_payments SET bank_txn_id = ? WHERE bank_txn_id = ?', [keep, drop]); movedLinks += sal.length; }
      }
      await t.run('DELETE FROM bank_transactions WHERE id = ?', [drop]);
      // המזהה של המשיכה עובר לשורת הקובץ — אחרת המשיכה הבאה (60 יום אחורה) הייתה מכניסה אותה שוב.
      // מזהה נוכחי עובר לשורת הקובץ (המשיכה הבאה תזהה אותה); מזהה ישן לא — המשיכה הבאה תאמץ אותה במזהה של היום.
      if (p.replaceId && d.external_id != null) await t.run('UPDATE bank_transactions SET external_id = ? WHERE id = ?', [d.external_id, keep]);
      else if (p.takeId && d.external_id != null) await t.run('UPDATE bank_transactions SET external_id = ? WHERE id = ? AND external_id IS NULL', [d.external_id, keep]);
      merged += 1;
    }
  });
  await logAction(
    { userId: actor?.id ?? null, action: 'bank.duplicates_merge', entityType: 'bank_account', entityId: Number(accountId),
      details: { merged, movedLinks, pairs: mergeable.map((p) => [Number(p.keep.id), Number(p.drop.id)]) } },
    x,
  );
  return { merged, movedLinks };
}
