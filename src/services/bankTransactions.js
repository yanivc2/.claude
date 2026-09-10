import { getExecutor, tx } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';
import { plainNumber, isOddNumberText } from '../lib/numText.js';
import { decodeFileName } from '../lib/decodeText.js';

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
  await tx(async (t) => {
    for (const r of rows) {
      if (!r || !r.txnDate || !Number.isFinite(r.amount)) {
        throw new RuleError('VALIDATION', 'שורת תנועה לא תקינה (חסר תאריך או סכום)');
      }
      const desc = r.description ?? null;
      const ref = r.rawReference ?? null;
      const externalId = r.externalId ?? null;
      // A row that carries the provider's own id (Open Banking sync) dedupes on THAT — the bank may
      // restate a line's description or value date between pulls, and an overlapping date window is
      // re-fetched on every sync. Rows without one (CSV / manual) keep the field-equality check.
      const dup = externalId
        ? await t.one(
            'SELECT id FROM bank_transactions WHERE bank_account_id = ? AND external_id = ?',
            [bankAccountId, externalId],
          )
        : await t.one(
            `SELECT id FROM bank_transactions
              WHERE bank_account_id = ? AND txn_date = ? AND amount = ?
                AND COALESCE(description,'') = COALESCE(?, '') AND COALESCE(raw_reference,'') = COALESCE(?, '')`,
            [bankAccountId, r.txnDate, r.amount, desc, ref],
          );
      if (dup) {
        skipped += 1;
        continue;
      }
      await t.run(
        `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, balance_after, source, external_id, import_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bankAccountId, r.txnDate, r.amount, desc, ref, Number.isFinite(r.balanceAfter) ? r.balanceAfter : null, source, externalId, importId],
      );
      inserted += 1;
    }
  });

  await x.run('UPDATE bank_imports SET inserted = ?, skipped = ? WHERE id = ?', [inserted, skipped, importId]);
  await logAction(
    { userId: actor?.id ?? null, action: 'bank.import', entityType: 'bank_account', entityId: bankAccountId, details: { source, inserted, skipped, importId, fileName } },
    x,
  );
  return { inserted, skipped, importId };
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
  return imports.map((imp) => {
    const mine = rows.filter((r) => Number(r.import_id) === Number(imp.id));
    const matched = mine.filter((r) => r.matched_payment_id != null).length;
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
  const matched = mine.filter((r) => r.matched_payment_id != null);
  const free = mine.filter((r) => r.matched_payment_id == null);

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
    for (const r of matched) { await unmatch(r.id, actor, x); released += 1; }
  }
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
  if (matched.length && !releaseMatched) {
    throw new RuleError('MATCHED', `${matched.length} מתנועות הייבוא כבר הותאמו לצ׳קים — אישור נוסף נדרש כדי לבטל את ההתאמות ולמחוק.`);
  }
  let released = 0;
  if (matched.length) {
    // כמו ב-deleteTransactions: ניתוק השדה לבדו היה משאיר את הצ׳ק "נפרע".
    const { unmatch } = await import('./reconciliation.js');
    for (const r of matched) { await unmatch(r.id, actor, x); released += 1; }
  }
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
export async function listUnmatched(bankAccountId, x = getExecutor()) {
  return x.many(
    `SELECT * FROM bank_transactions
      WHERE bank_account_id = ? AND matched_payment_id IS NULL AND amount < 0
      ORDER BY txn_date`,
    [bankAccountId],
  );
}

/** All transactions for an account, newest first, with any matched check number joined. */
export async function listTransactions(bankAccountId, x = getExecutor()) {
  return x.many(
    `SELECT bt.*, p.method AS matched_method,
            COALESCE(p.check_number, p.reference, p.batch_number) AS matched_check_number
       FROM bank_transactions bt
       LEFT JOIN payments p ON p.id = bt.matched_payment_id
      WHERE bt.bank_account_id = ?
      ORDER BY bt.txn_date DESC, bt.id DESC`,
    [bankAccountId],
  );
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
  await x.run('DELETE FROM bank_transactions WHERE id = ?', [id]);
  await logAction({ userId: actor?.id ?? null, action: 'bank.txn_delete', entityType: 'bank_transaction', entityId: id }, x);
  return txn;
}
