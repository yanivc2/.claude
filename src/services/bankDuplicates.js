// איחוד כפילויות בתוך חשבון אחד — שורת קובץ (Excel/CSV) ותאומתה מהמשיכה מהבנק.
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
// המשיכה (כך שמשיכה הבאה מזהה אותה ולא מכפילה שוב), וכל מה שהיה קשור לעותק — התאמת תשלום,
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

/**
 * זיווג שורות קובץ (בלי מזהה) לשורות משיכה (עם מזהה) באותו חשבון — אותו סכום, עד 3 ימים,
 * תאריך זהה לפני טווח, אסמכתא זהה מועדפת, כל שורה פעם אחת. טהור.
 */
export function pairDuplicates(rows) {
  const files = rows.filter((r) => r.external_id == null && FILE_SOURCES.has(r.source));
  const pulled = rows.filter((r) => r.external_id != null && PULL_SOURCES.has(r.source) && r.balance_after == null)
    .map((r) => ({ r, taken: false }));
  const pairs = [];
  const paired = new Set();
  for (const maxDays of [0, MAX_DAYS]) {
    for (const f of files) {
      if (paired.has(f.id)) continue;
      const ref = refOf(f.raw_reference);
      let best = null;
      let bestScore = Infinity;
      for (const p of pulled) {
        if (p.taken || Number(p.r.amount) !== Number(f.amount)) continue;
        const d = dayDiff(p.r.txn_date, f.txn_date);
        if (!(d <= maxDays)) continue;
        const score = d + (ref && refOf(p.r.raw_reference) === ref ? -10 : 0);
        if (score < bestScore) { best = p; bestScore = score; }
      }
      if (best) {
        best.taken = true;
        paired.add(f.id);
        pairs.push({ keep: f, drop: best.r });
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
        || Number(d.bank_account_id) !== Number(accountId) || k.external_id != null) continue;
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
      await t.run('UPDATE bank_transactions SET external_id = ? WHERE id = ? AND external_id IS NULL', [d.external_id, keep]);
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
