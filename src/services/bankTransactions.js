import { getExecutor, tx } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';
import { plainNumber, isOddNumberText } from '../lib/numText.js';
import { decodeFileName } from '../lib/decodeText.js';
import { getSetting, setSetting } from './appSettings.js';

// Stage 2: bank transactions land here (from the scraper, a CSV export, or manual entry)
// and are then reconciled against open checks by the R7 engine. Amounts are signed agorot
// — a debit (charge, e.g. a cleared check) is negative, matching the scraper's chargedAmount.

/**
 * Import a batch of transactions for one bank account. Idempotent on
 * (txn_date, amount, description, raw_reference).
 * @returns {{inserted:number, skipped:number}}
 */
export async function importTransactions(bankAccountId, rows, source, actor, x = getExecutor(), { fileName = null } = {}) {
  const account = await x.one('SELECT id FROM bank_accounts WHERE id = ?', [bankAccountId]);
  if (!account) throw new NotFoundError(`חשבון בנק ${bankAccountId} לא נמצא`);

  // 🔴 לפני בדיקת הכפילות, לא אחריה. הבדיקה משווה אסמכתא מול אסמכתא ב-SQL; שורה ישנה שנשמרה
  // כ-`1.81732779E8` מול שורה חדשה שנקראת כ-`181732779` תיראה לה כתנועה אחרת, והעלאה חוזרת של
  // אותו קובץ הייתה מכפילה כל שורה. הקנוניזציה מיישרת את שני הצדדים מראש.
  await normalizeStoredReferences(bankAccountId, actor, x);

  // כל העלאה נרשמת כאירוע, וכל שורה נושאת את מזהה ההעלאה שהביאה אותה. בלי זה אין דרך לדעת מה
  // הועלה ומתי — ולכן גם אין דרך לבטל קובץ שהועלה לחשבון הלא נכון.
  const batch = await x.run(
    `INSERT INTO bank_imports (bank_account_id, source, file_name, rows_total, imported_by)
     VALUES (?, ?, ?, ?, ?)`,
    [bankAccountId, source, (fileName || '').toString().trim() || null, (rows || []).length, actor?.id ?? null],
  );
  const importId = batch.lastInsertRowid;

  let inserted = 0;
  let skipped = 0;
  let adopted = 0;
  await tx(async (t) => {
    // כל מה שכבר בחשבון נטען פעם אחת — בדיקת כפילות בזיכרון במקום SELECT לכל שורה. משיכה מהבנק
    // מביאה ~2,000 שורות, ושתי קריאות מסד לכל שורה מ-Vercel ל-Neon הן דקות.
    const existing = await t.many(
      'SELECT id, txn_date, amount, description, raw_reference, external_id FROM bank_transactions WHERE bank_account_id = ?',
      [bankAccountId],
    );
    const fieldKey = (date, amount, desc, ref) => `${date}|${amount}|${desc ?? ''}|${ref ?? ''}`;
    const byExternal = new Set();
    const byFields = new Set();
    // 🔴 שורות שהגיעו מקובץ (Excel/CSV) נושאות external_id ריק. שורה מהבנק נושאת מזהה משלה — ולכן
    // בדיקה לפי מזהה בלבד לא רואה אותן, וכל החפיפה בין הקובץ האחרון למשיכה (60 יום) הייתה נקלטת
    // פעמיים. התיאור אינו מפתח כאן: הקובץ והאתר מנסחים אותו אחרת. ההתאמה: אותו סכום, עד 3 ימים
    // הפרש (תאריך ערך מול תאריך פעולה), אסמכתא זהה מועדפת, כל שורה ישנה נתפסת פעם אחת בלבד.
    const legacy = [];
    for (const e of existing) {
      if (e.external_id) {
        byExternal.add(e.external_id);
        // מזהה סריקה בפורמט הישן (`scr:חברה:חשבון:אסמכתא`, לפני שנוספו תאריך+סכום): המזהה החדש של
        // אותה שורה הוא בדיוק הישן + `:תאריך:סכום` — ולכן גוזרים אותו ממה שנשמר, ומשיכה חדשה מזהה אותה.
        if (/^scr:[^:]*:[^:]*:[^:]+$/.test(e.external_id)) byExternal.add(`${e.external_id}:${e.txn_date}:${e.amount}`);
      }
      else legacy.push({ id: e.id, date: e.txn_date, amount: e.amount, ref: plainNumber(e.raw_reference ?? '') || null, taken: false });
      byFields.add(fieldKey(e.txn_date, e.amount, e.description, e.raw_reference));
    }
    const dayDiff = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
    const claimLegacy = (r, maxDays) => {
      const ref = plainNumber(r.rawReference ?? '') || null;
      let best = null;
      let bestScore = Infinity;
      for (const l of legacy) {
        if (l.taken || Number(l.amount) !== Number(r.amount)) continue;
        const d = dayDiff(l.date, r.txnDate);
        if (!(d <= maxDays)) continue;
        const score = d + (ref && l.ref === ref ? -10 : 0);
        if (score < bestScore) { best = l; bestScore = score; }
      }
      if (best) best.taken = true;
      return best;
    };

    for (const r of rows) {
      if (!r || !r.txnDate || !Number.isFinite(r.amount)) {
        throw new RuleError('VALIDATION', 'שורת תנועה לא תקינה (חסר תאריך או סכום)');
      }
    }
    // שני מעברים: קודם התאמות באותו תאריך בדיוק, ורק אחר כך בטווח. אחרת עמלה קבועה שחוזרת כל יום
    // (אותו סכום) הייתה תופסת את השורה הישנה של אתמול, ושורת היום האמיתית הייתה נדחקת.
    const adoptedRow = new Map();
    for (const maxDays of [0, 3]) {
      for (const r of rows) {
        const externalId = r.externalId ?? null;
        if (!externalId || byExternal.has(externalId) || adoptedRow.has(r) || !legacy.length) continue;
        const hit = claimLegacy(r, maxDays);
        if (hit) adoptedRow.set(r, hit);
      }
    }

    for (const r of rows) {
      const desc = r.description ?? null;
      const ref = r.rawReference ?? null;
      const externalId = r.externalId ?? null;
      // A row that carries the provider's own id (Open Banking sync / bank agent) dedupes on THAT — the
      // bank may restate a line's description or value date between pulls, and an overlapping date
      // window is re-fetched on every sync. Rows without one (CSV / manual) keep the field-equality check.
      if (externalId ? byExternal.has(externalId) : byFields.has(fieldKey(r.txnDate, r.amount, desc, ref))) {
        skipped += 1;
        continue;
      }
      const hit = adoptedRow.get(r);
      if (hit) {
        // השורה כבר קיימת מהקובץ: היא נשארת (עם ההתאמות שלה), ומקבלת את המזהה של הבנק כדי
        // שמשיכה הבאה תזהה אותה ישירות.
        await t.run('UPDATE bank_transactions SET external_id = ? WHERE id = ? AND external_id IS NULL', [externalId, hit.id]);
        byExternal.add(externalId);
        skipped += 1;
        adopted += 1;
        continue;
      }
      await t.run(
        `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, balance_after, source, external_id, import_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bankAccountId, r.txnDate, r.amount, desc, ref, Number.isFinite(r.balanceAfter) ? r.balanceAfter : null, source, externalId, importId],
      );
      if (externalId) byExternal.add(externalId);
      byFields.add(fieldKey(r.txnDate, r.amount, desc, ref));
      inserted += 1;
    }
  });

  await x.run('UPDATE bank_imports SET inserted = ?, skipped = ? WHERE id = ?', [inserted, skipped, importId]);
  await logAction(
    { userId: actor?.id ?? null, action: 'bank.import', entityType: 'bank_account', entityId: bankAccountId, details: { source, inserted, skipped, adopted, importId, fileName } },
    x,
  );
  return { inserted, skipped, adopted, importId };
}

/**
 * האם `bank_imports` ו-`bank_transactions.import_id` כבר קיימים במסד?
 *
 * 🔴 בלי הבדיקה הזו, ה-`catch` שמגן על מסד לפני עדכון הופך "אין טבלה" ל"אין נתונים" — הדף מציג
 * "עדיין לא יובאו קבצים" מול חשבון מלא בתנועות, וזה בדיוק אותו שקר בתצוגה שהוא אמור למנוע.
 * המשתמש צריך לדעת שהוא צריך ללחוץ "עדכן מסד נתונים", לא לחשוב שהמידע נעלם.
 */
/**
 * "ניקוי לפי קובץ" — אילו תנועות בחשבון הזה הגיעו מהקובץ הזה.
 *
 * המצב שזה פותר: קובץ שהועלה לחשבון הלא נכון **לפני** שמעקב הייבוא היה קיים. אין לשורות סימון
 * קובץ, והן נראות בדיוק כמו כל תנועה אחרת — 1,157 שורות שאי אפשר לברור ביניהן ביד. אבל הקובץ
 * עצמו עדיין אצל הבעלים, והוא הסימן המדויק: מעלים אותו שוב, ומוצאים את השורות שהוא הביא.
 *
 * ההתאמה היא **אותה שקילות בדיוק** שהייבוא משתמש בה כדי לזהות כפילות
 * (תאריך + סכום + תיאור + אסמכתה), ולכן שורה שהקובץ יצר תימצא, ושורה שלא — לא.
 * כל שורה בקובץ תופסת לכל היותר תנועה אחת, כדי ששתי שורות זהות בקובץ לא ימחקו שלוש תנועות.
 *
 * @returns {Promise<{ids:number[], matched:number[], rows:Array}>}
 */
export async function matchRowsToTransactions(bankAccountId, rows, x = getExecutor()) {
  const txns = await x.many(
    'SELECT id, txn_date, amount, description, raw_reference, matched_payment_id FROM bank_transactions WHERE bank_account_id = ?',
    [Number(bankAccountId)],
  );
  // 🔴 האסמכתא מקונוננת בשני הצדדים. שורה שנשמרה לפני התיקון נושאת `1.81732779E8` ואילו קריאה
  // חדשה של אותו קובץ נותנת `181732779` — אותו מספר, שני מפתחות, והקובץ לא היה מוצא את השורות
  // שהוא עצמו יצר. `plainNumber` על שני הצדדים מבטל את ההפרש הזה בלי לגעת בנתונים.
  const key = (d, a, desc, ref) =>
    [d, Number(a), (desc ?? '') || '', plainNumber((ref ?? '') || '')].join('|');
  const pool = new Map();
  for (const t of txns) {
    const k = key(t.txn_date, t.amount, t.description, t.raw_reference);
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(t);
  }
  const hits = [];
  for (const r of rows || []) {
    if (!r || !r.txnDate || !Number.isFinite(r.amount)) continue;
    const bucket = pool.get(key(r.txnDate, r.amount, r.description ?? null, r.rawReference ?? null));
    if (bucket && bucket.length) hits.push(bucket.shift());   // כל שורה תופסת תנועה אחת בלבד
  }
  return {
    ids: hits.filter((t) => t.matched_payment_id == null).map((t) => Number(t.id)),
    matched: hits.filter((t) => t.matched_payment_id != null).map((t) => Number(t.id)),
    rows: hits,
  };
}

/**
 * אסמכתאות שנשמרו בכתיב שאי אפשר לקרוא — `1.81732779E8` במקום `181732779`, `26411.0` במקום
 * `26411`. זה מה שהיצואן של דף הבנק כותב, וזה נכנס למסד כמו שהוא.
 *
 * 🔴 זו לא תקלת תצוגה. אסמכתא היא מפתח ההשוואה מול מספר הצ׳ק (התאמה דטרמיניסטית) ומול מספר
 * שקית ההפקדה — ומספר שנכתב בכתיב מדעי פשוט לא שווה לאף אחד מהם. לכן התיקון הוא **בנתון**
 * ולא בעיצוב: אחרת המסך ייראה תקין וההתאמה תמשיך להיכשל בשקט.
 *
 * @returns {Promise<{count:number, sample:string[]}>}
 */
export async function oddReferences(accountId = null, x = getExecutor()) {
  const rows = accountId
    ? await x.many('SELECT id, raw_reference FROM bank_transactions WHERE bank_account_id = ?', [Number(accountId)])
    : await x.many('SELECT id, raw_reference FROM bank_transactions', []);
  const odd = rows.filter((r) => isOddNumberText(r.raw_reference));
  return { count: odd.length, sample: odd.slice(0, 3).map((r) => String(r.raw_reference)) };
}

/**
 * כותב את אותן אסמכתאות בספרות. פעולה קנונית בלבד — אותו מספר בדיוק, כתיב אחר — ולכן היא
 * בטוחה לחזרה ואינה משנה שום התאמה קיימת.
 * @returns {Promise<{fixed:number}>}
 */
export async function normalizeStoredReferences(accountId = null, actor = null, x = getExecutor()) {
  const rows = accountId
    ? await x.many('SELECT id, raw_reference FROM bank_transactions WHERE bank_account_id = ?', [Number(accountId)])
    : await x.many('SELECT id, raw_reference FROM bank_transactions', []);
  let fixed = 0;
  for (const r of rows) {
    if (!isOddNumberText(r.raw_reference)) continue;
    const clean = plainNumber(r.raw_reference);
    if (clean === String(r.raw_reference)) continue;
    await x.run('UPDATE bank_transactions SET raw_reference = ? WHERE id = ?', [clean, r.id]);
    fixed += 1;
  }
  if (fixed) {
    await logAction(
      { userId: actor?.id ?? null, action: 'bank.refs_normalized', entityType: 'bank_account', entityId: accountId ? Number(accountId) : null, details: { fixed } },
      x,
    );
  }
  return { fixed };
}

export async function importsReady(x = getExecutor()) {
  try {
    await x.many('SELECT id FROM bank_imports LIMIT 1', []);
    await x.many('SELECT import_id FROM bank_transactions LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

/**
 * ההעלאות האחרונות לחשבון, כל אחת עם כמה משורותיה עדיין קיימות וכמה מהן כבר הותאמו לצ׳ק.
 * זה מה שעונה על "האם הקובץ נשמר ומוכן להתאמה" — ועל "מה בעצם העליתי לכאן".
 */
export async function listImports({ accountId = null, limit = 20 } = {}, x = getExecutor()) {
  let imports;
  try {
    imports = accountId
      ? await x.many('SELECT * FROM bank_imports WHERE bank_account_id = ? ORDER BY id DESC LIMIT ?', [Number(accountId), limit])
      : await x.many('SELECT * FROM bank_imports ORDER BY id DESC LIMIT ?', [limit]);
  } catch {
    return []; // מסד לפני העדכון
  }
  if (!imports.length) return [];
  // ספירה ב-JS ולא ב-GROUP BY: pg-mem אינו תומך ב-GROUP BY מעל join, וזו רשימה קצרה וחסומה.
  const rows = await x.many(
    'SELECT import_id, matched_payment_id FROM bank_transactions WHERE import_id IS NOT NULL', [],
  );
  const users = await x.many('SELECT id, name FROM users', []);
  const byUser = new Map(users.map((u) => [Number(u.id), u.name]));
  // התאמה = לצ׳ק **או להפקדה** — אחרת ייבוא שהותאם רק להפקדות היה נראה "לא מותאם", הכפתור לא היה
  // שולח את האישור, והביטול היה נדחה בלי דרך לאשר.
  const depRows = await x.many('SELECT matched_txn_id FROM deposits WHERE matched_txn_id IS NOT NULL', []);
  const depTxn = new Set(depRows.map((d) => Number(d.matched_txn_id)));
  const withIds = await x.many('SELECT id, import_id FROM bank_transactions WHERE import_id IS NOT NULL', []);
  const depByImport = new Map();
  for (const r of withIds) if (depTxn.has(Number(r.id))) depByImport.set(Number(r.import_id), (depByImport.get(Number(r.import_id)) || 0) + 1);
  return imports.map((imp) => {
    const mine = rows.filter((r) => Number(r.import_id) === Number(imp.id));
    const matched = mine.filter((r) => r.matched_payment_id != null).length + (depByImport.get(Number(imp.id)) || 0);
    return {
      ...imp,
      // שם שנשמר לפני שהפענוח היה קיים נשמר כג'יבריש; `decodeFileName` בטוחה לקריאה חוזרת ולכן
      // היא מיישרת גם אותו, בלי לכתוב מחדש שורה במסד ובלי לפגוע בשם שכבר תקין.
      file_name: decodeFileName(imp.file_name),
      present: mine.length,               // שורות שעדיין קיימות (חלקן אולי נמחקו ידנית)
      matched,
      unmatched: mine.length - matched,
      imported_by_name: byUser.get(Number(imp.imported_by)) || null,
      deletable: mine.length > 0,
    };
  });
}

/**
 * התנועות בחשבון שאין להן ייבוא מזוהה — כל מה שהועלה **לפני** שהמעקב הזה קיים.
 *
 * בלי זה הרובריקה אומרת "עדיין לא יובאו קבצים" מול חשבון שמלא בתנועות, וזה פשוט לא נכון. אי
 * אפשר לשחזר לאיזה קובץ הן שייכות — הנתון הזה לא נשמר אז — ולכן הן מוצגות כקבוצה אחת עם טווח
 * תאריכים, ולא כ"ייבוא" שאפשר לבטל בלחיצה: מחיקה גורפת שלהן הייתה מוחקת גם תנועות אמיתיות.
 */
/**
 * 🔴 תנועה יכולה להיות מותאמת לשני דברים: צ׳ק (`matched_payment_id`) **או הפקדה**
 * (`deposits.matched_txn_id`, FK). מחיקה ששחררה רק צ׳קים נפלה ב-Postgres על ה-FK של ההפקדה —
 * **אחרי** שהצ׳קים כבר שוחררו, כלומר מצב חצי-מבוצע. לכן: מונים את שני הסוגים, ומשחררים את שניהם
 * לפני DELETE. ההפקדה חוזרת ל"ממתינה להתאמה" (`deposited` נשאר — הכסף אכן הופקד).
 */
async function depositLinks(ids, x) {
  const set = new Set((ids || []).map(Number));
  if (!set.size) return [];
  const rows = await x.many('SELECT id, matched_txn_id FROM deposits WHERE matched_txn_id IS NOT NULL', []);
  return rows.filter((d) => set.has(Number(d.matched_txn_id)));
}
/** צ׳ק שכר ששויך לתנועה שנמחקת חוזר ל"לא נפרע" — גם ב-SQLite, שבו FK ON DELETE לא מובטח. */
async function releaseSalaryLinks(ids, x) {
  const { salaryBankReady } = await import('./salaryPayments.js');
  if (!(await salaryBankReady(x))) return;
  for (const id of ids || []) await x.run('UPDATE salary_payments SET bank_txn_id = NULL WHERE bank_txn_id = ?', [Number(id)]);
}

async function releaseDeposits(links, actor, x) {
  for (const d of links) {
    await x.run('UPDATE deposits SET matched_txn_id = NULL, recon_diff = NULL WHERE id = ?', [d.id]);
    await logAction({ userId: actor?.id ?? null, action: 'deposit.unmatch', entityType: 'deposit', entityId: d.id, details: { txnId: d.matched_txn_id } }, x);
  }
  return links.length;
}

/**
 * מחיקת כמה תנועות בבת אחת — הכלי לניקוי שורות שהועלו לחשבון הלא נכון, כולל כאלה שקדמו למעקב
 * הייבוא ואין להן קובץ לבטל.
 *
 * 🔴 שורה מותאמת אינה נמחקת: היא מדולגת ונספרת. מחיקה שקטה שלה הייתה מנתקת צ׳ק מההתאמה שלו.
 * הקורא מקבל את המספר ואומר אותו למשתמש.
 *
 * @param {number[]} ids
 * @returns {Promise<{deleted:number, skippedMatched:number}>}
 */
export async function deleteTransactions(ids, accountId, actor, { releaseMatched = false } = {}, x = getExecutor()) {
  const wanted = [...new Set((ids || []).map(Number).filter(Boolean))];
  if (!wanted.length) throw new RuleError('VALIDATION', 'לא נבחרו תנועות');
  // כל השורות נשלפות ומסוננות לחשבון הזה — מזהה מזויף לא ימחק תנועה של חשבון אחר.
  const rows = await x.many('SELECT id, matched_payment_id FROM bank_transactions WHERE bank_account_id = ?', [Number(accountId)]);
  const mine = rows.filter((r) => wanted.includes(Number(r.id)));
  const links = await depositLinks(mine.map((r) => r.id), x);
  const depTxn = new Set(links.map((d) => Number(d.matched_txn_id)));
  const matched = mine.filter((r) => r.matched_payment_id != null || depTxn.has(Number(r.id)));
  const free = mine.filter((r) => r.matched_payment_id == null && !depTxn.has(Number(r.id)));

  // `releaseMatched` = המשתמש ראה כמה התאמות ישוחררו ואישר. זה המצב של "פרטי בנק שאינם שייכים
  // לחשבון הזה בכלל": ההתאמה שנעשתה מולם היא **התאמת שווא** — הצ׳ק לא נפרע בתנועה הזו — ולכן
  // שחרורה הוא התיקון, לא נזק. הצ׳ק חוזר לרשימת הפתוחים וממתין לתנועה האמיתית שלו.
  const toDelete = releaseMatched ? [...free, ...matched] : free;
  let released = 0;
  if (releaseMatched) {
    // 🔴 דרך `unmatch` ולא ב-UPDATE ישיר: ניתוק השדה לבדו משאיר את התשלום ב-`cleared` עם
    // `cleared_date`, כלומר הצ׳ק ממשיך להיראות פרוע ואינו חוזר לרשימת הפתוחים — בדיוק ההפך
    // ממה שהמסך מבטיח. `unmatch` מחזיר גם את סטטוס התשלום.
    const { unmatch } = await import('./reconciliation.js');
    released += await releaseDeposits(links, actor, x);
    for (const r of matched) if (r.matched_payment_id != null) { await unmatch(r.id, actor, x); released += 1; }
  }
  await releaseSalaryLinks(toDelete.map((r) => r.id), x);
  for (const r of toDelete) await x.run('DELETE FROM bank_transactions WHERE id = ?', [r.id]);
  await logAction(
    { userId: actor?.id ?? null, action: 'bank.txn_bulk_delete', entityType: 'bank_account', entityId: Number(accountId),
      details: { deleted: toDelete.length, released, skippedMatched: releaseMatched ? 0 : matched.length } },
    x,
  );
  return { deleted: toDelete.length, released, skippedMatched: releaseMatched ? 0 : matched.length };
}

export async function untrackedSummary(accountId, x = getExecutor()) {
  let rows;
  try {
    rows = await x.many(
      'SELECT txn_date, source, matched_payment_id FROM bank_transactions WHERE bank_account_id = ? AND import_id IS NULL',
      [Number(accountId)],
    );
  } catch {
    return null;
  }
  if (!rows.length) return null;
  const dates = rows.map((r) => r.txn_date).filter(Boolean).sort();
  return {
    count: rows.length,
    matched: rows.filter((r) => r.matched_payment_id != null).length,
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
    sources: [...new Set(rows.map((r) => r.source))].join(', '),
  };
}

export async function getImport(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM bank_imports WHERE id = ?', [Number(id)]);
  if (!row) throw new NotFoundError(`ייבוא ${id} לא נמצא`);
  return row;
}

/**
 * ביטול ייבוא: מוחק את התנועות שהגיעו בו.
 *
 * 🔴 שורה שכבר הותאמה לצ׳ק **אינה נמחקת בשקט** — מחיקה כזו הייתה מנתקת את הצ׳ק מההתאמה שלו בלי
 * שאיש ביקש. ברירת המחדל היא לסרב ולומר כמה שורות מותאמות; רק `{ releaseMatched: true }` — כלומר
 * אישור מפורש של המשתמש שראה את המספר — מבטל את ההתאמות ואז מוחק.
 *
 * @returns {{deleted:number, released:number, kept:number}}
 */
export async function deleteImport(id, actor, { releaseMatched = false } = {}, x = getExecutor()) {
  const imp = await getImport(id, x);
  const rows = await x.many('SELECT id, matched_payment_id FROM bank_transactions WHERE import_id = ?', [imp.id]);
  const matched = rows.filter((r) => r.matched_payment_id != null);
  const links = await depositLinks(rows.map((r) => r.id), x);
  if ((matched.length || links.length) && !releaseMatched) {
    throw new RuleError('MATCHED', `${matched.length + links.length} מתנועות הייבוא כבר הותאמו (לצ׳קים או להפקדות) — אישור נוסף נדרש כדי לבטל את ההתאמות ולמחוק.`);
  }
  let released = 0;
  released += await releaseDeposits(links, actor, x);
  if (matched.length) {
    // כמו ב-deleteTransactions: ניתוק השדה לבדו היה משאיר את הצ׳ק "נפרע".
    const { unmatch } = await import('./reconciliation.js');
    for (const r of matched) { await unmatch(r.id, actor, x); released += 1; }
  }
  await releaseSalaryLinks(rows.map((r) => r.id), x);
  await x.run('DELETE FROM bank_transactions WHERE import_id = ?', [imp.id]);
  await x.run('DELETE FROM bank_imports WHERE id = ?', [imp.id]);
  await logAction(
    { userId: actor?.id ?? null, action: 'bank.import_delete', entityType: 'bank_account', entityId: Number(imp.bank_account_id),
      details: { importId: imp.id, fileName: imp.file_name, deleted: rows.length, released } },
    x,
  );
  return { deleted: rows.length, released, kept: 0 };
}

/** Unmatched debit transactions for an account (candidates for check reconciliation). */
/**
 * "תאריך תחילת עבודה" — חיובים לא מותאמים **עד התאריך הזה (כולל)** אינם מוצגים ב"תנועות לא
 * מותאמות". הבעלים התחיל לעבוד עם התוכנה בתחילת ספטמבר, וצ׳קים ניתנים לרוב 30 יום קדימה, ולכן
 * כל חיוב צ׳ק עד סוף ספטמבר הוא צ׳ק שהונפק לפני התוכנה — "אין צ׳ק פתוח תואם" בהגדרה, ורעש.
 *
 * 🔴 הסתרה ולא מחיקה, משתי סיבות שנמדדו בקוד: (1) הסוכן מושך **60 יום אחורה** בכל סנכרון
 * (`agent/bank-agent.mjs`, `startDaysBack`), ולכן שורה שנמחקה הייתה חוזרת בסנכרון הבא; (2) צ׳ק
 * שהונפק בתוכנה בספטמבר בתאריך מיידי צריך את שורת החיוב שלו כדי להיסגר — שורה מוסתרת עדיין
 * מותאמת אוטומטית (`autoReconcile` אינו מסנן לפי התאריך הזה), שורה מחוקה לא.
 * גלובלי לכל החשבונות (אותו יום התחלה לכל הסניפים). ריק = אין הסתרה.
 */
export const HIDE_UNMATCHED_KEY = 'bank_unmatched_hidden_until';
export async function unmatchedHiddenUntil(x = getExecutor()) {
  const v = await getSetting(HIDE_UNMATCHED_KEY, null, x);
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : null;
}
export async function setUnmatchedHiddenUntil(date, actor, x = getExecutor()) {
  const v = String(date || '').trim();
  if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new RuleError('VALIDATION', 'תאריך לא תקין');
  await setSetting(HIDE_UNMATCHED_KEY, v || null, x);
  await logAction({ userId: actor?.id ?? null, action: 'bank.hide_unmatched_until', entityType: 'app_settings', entityId: null, details: { until: v || null } }, x);
  return v || null;
}

/**
 * אסמכתאות של הפקדות שכבר אותרו בבנק בחשבון הזה → מספר השקית. שורה באותה אסמכתה היא הזיכוי של
 * השקית **או תיקון שלה** (הבנק מבטל ומזכה מחדש באותה אסמכתה — services/deposits.js
 * #depositVerifications). חיוב-הביטוי של תיקון כזה הוצג כ"ממתין להתאמה" בין הצ׳קים, כאילו כסף
 * יצא בלי הסבר.
 */
export async function depositRefsForAccount(bankAccountId, x = getExecutor()) {
  const out = new Map();
  const acc = await x.one('SELECT store_id FROM bank_accounts WHERE id = ?', [bankAccountId]);
  if (!acc) return out;
  const { bagReferences } = await import('./deposits.js');
  const deps = await x.many('SELECT bag_number FROM deposits WHERE store_id = ? AND matched_txn_id IS NOT NULL', [acc.store_id]);
  for (const d of deps) for (const r of bagReferences(d.bag_number)) out.set(r, d.bag_number);
  return out;
}
const txnRef = (t) => plainNumber(String(t.raw_reference ?? '').trim());

async function unmatchedAll(bankAccountId, x) {
  const { salaryLinkedTxnIds } = await import('./salaryPayments.js');
  const salaryTaken = await salaryLinkedTxnIds(x); // צ׳ק שכר שנפרע — מוסבר, לא "ממתין"
  const depRefs = await depositRefsForAccount(bankAccountId, x); // תיקון הפקדה — מוסבר
  return (await x.many(
    `SELECT * FROM bank_transactions
      WHERE bank_account_id = ? AND matched_payment_id IS NULL AND amount < 0
      ORDER BY txn_date`,
    [bankAccountId],
  )).filter((t) => !salaryTaken.has(Number(t.id)) && !depRefs.has(txnRef(t)));
}

/** חיובים לא מותאמים — בלי אלה שעד "תאריך תחילת העבודה" (ראה unmatchedHiddenUntil). */
export async function listUnmatched(bankAccountId, x = getExecutor()) {
  const until = await unmatchedHiddenUntil(x);
  const all = await unmatchedAll(bankAccountId, x);
  return until ? all.filter((t) => String(t.txn_date).slice(0, 10) > until) : all;
}

/** כמה חיובים לא מותאמים מוסתרים בחשבון בגלל תאריך תחילת העבודה. */
export async function hiddenUnmatchedCount(bankAccountId, x = getExecutor()) {
  const until = await unmatchedHiddenUntil(x);
  if (!until) return 0;
  return (await unmatchedAll(bankAccountId, x)).filter((t) => String(t.txn_date).slice(0, 10) <= until).length;
}

/** All transactions for an account, newest first, with any matched check number joined. */
export async function listTransactions(bankAccountId, x = getExecutor()) {
  const rows = await x.many(
    `SELECT bt.*, p.method AS matched_method,
            COALESCE(p.check_number, p.reference, p.batch_number) AS matched_check_number
       FROM bank_transactions bt
       LEFT JOIN payments p ON p.id = bt.matched_payment_id
      WHERE bt.bank_account_id = ?
      ORDER BY bt.txn_date DESC, bt.id DESC`,
    [bankAccountId],
  );
  // צ׳ק שכר שנפרע — "נפרע · שכר · שם העובד" במקום "ממתין להתאמה".
  const { salaryBankReady } = await import('./salaryPayments.js');
  if (rows.length && (await salaryBankReady(x))) {
    const sal = await x.many(
      `SELECT sp.bank_txn_id, sp.reference, e.first_name, e.last_name
         FROM salary_payments sp JOIN employees e ON e.id = sp.employee_id
        WHERE sp.bank_txn_id IS NOT NULL`,
      [],
    );
    const byTxn = new Map(sal.map((r) => [Number(r.bank_txn_id), r]));
    for (const r of rows) {
      const s = byTxn.get(Number(r.id));
      if (s) r.salary_match = { name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), reference: s.reference };
    }
  }
  // הפקדה שאותרה (זיכוי השקית ושורות התיקון שלה) — "הפקדה · שקית" ולא "ממתין להתאמה"/"זכות".
  const depRefs = rows.length ? await depositRefsForAccount(bankAccountId, x) : new Map();
  for (const r of rows) {
    const bag = depRefs.get(txnRef(r));
    if (bag && !r.matched_payment_id && !r.salary_match) r.deposit_match = { bag };
  }
  // "תאריך תחילת עבודה": שורה שלא הוסברה (לא צ׳ק/תשלום, לא שכר, לא הפקדה) עד התאריך מסומנת
  // `hidden_before_start` — התצוגה מסתירה אותה; היא אינה נמחקת (ראה unmatchedHiddenUntil).
  const until = rows.length ? await unmatchedHiddenUntil(x) : null;
  if (until) {
    for (const r of rows) {
      if (!r.matched_payment_id && !r.salary_match && !r.deposit_match && String(r.txn_date).slice(0, 10) <= until) r.hidden_before_start = true;
    }
  }
  return rows;
}

export async function getTransaction(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM bank_transactions WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`תנועת בנק ${id} לא נמצאה`);
  return row;
}

/**
 * Edit a manual/imported bank transaction's date, amount, description and reference.
 * Refused while the transaction is matched to a check (unmatch it first, so a match
 * can never silently point at changed figures).
 * @param {number} id
 * @param {{txnDate:string, amount:number, description:string|null, rawReference:string|null}} fields
 */
export async function editTransaction(id, fields, actor, x = getExecutor()) {
  const txn = await getTransaction(id, x);
  if (txn.matched_payment_id) {
    throw new RuleError('MATCHED', 'התנועה מותאמת לצ׳ק — בטל את ההתאמה לפני עריכה.');
  }
  if (!fields.txnDate || !Number.isFinite(fields.amount)) {
    throw new RuleError('VALIDATION', 'חסר תאריך או סכום תקין.');
  }
  await x.run(
    `UPDATE bank_transactions
        SET txn_date = ?, amount = ?, description = ?, raw_reference = ?
      WHERE id = ?`,
    [fields.txnDate, fields.amount, fields.description ?? null, fields.rawReference ?? null, id],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'bank.txn_edit', entityType: 'bank_transaction', entityId: id, details: { amount: fields.amount, txn_date: fields.txnDate } },
    x,
  );
  return getTransaction(id, x);
}

/** Delete a bank transaction. Refused if it is matched to a check (unmatch it first). */
export async function deleteTransaction(id, actor, x = getExecutor()) {
  const txn = await getTransaction(id, x);
  if (txn.matched_payment_id) {
    throw new RuleError('MATCHED', 'התנועה מותאמת לצ׳ק — בטל את ההתאמה לפני מחיקה.');
  }
  if ((await depositLinks([id], x)).length) {
    throw new RuleError('MATCHED', 'התנועה מותאמת להפקדה — בטל את ההתאמה לפני מחיקה.');
  }
  await releaseSalaryLinks([id], x);
  await x.run('DELETE FROM bank_transactions WHERE id = ?', [id]);
  await logAction({ userId: actor?.id ?? null, action: 'bank.txn_delete', entityType: 'bank_transaction', entityId: id }, x);
  return txn;
}
