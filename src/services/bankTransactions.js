import { getExecutor, tx } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

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
      present: mine.length,               // שורות שעדיין קיימות (חלקן אולי נמחקו ידנית)
      matched,
      unmatched: mine.length - matched,
      imported_by_name: byUser.get(Number(imp.imported_by)) || null,
      deletable: mine.length > 0,
    };
  });
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
  for (const r of matched) {
    await x.run('UPDATE bank_transactions SET matched_payment_id = NULL WHERE id = ?', [r.id]);
    released += 1;
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
