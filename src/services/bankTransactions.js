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
export async function importTransactions(bankAccountId, rows, source, actor, x = getExecutor()) {
  const account = await x.one('SELECT id FROM bank_accounts WHERE id = ?', [bankAccountId]);
  if (!account) throw new NotFoundError(`חשבון בנק ${bankAccountId} לא נמצא`);

  let inserted = 0;
  let skipped = 0;
  await tx(async (t) => {
    for (const r of rows) {
      if (!r || !r.txnDate || !Number.isFinite(r.amount)) {
        throw new RuleError('VALIDATION', 'שורת תנועה לא תקינה (חסר תאריך או סכום)');
      }
      const desc = r.description ?? null;
      const ref = r.rawReference ?? null;
      const dup = await t.one(
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
        `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [bankAccountId, r.txnDate, r.amount, desc, ref, source],
      );
      inserted += 1;
    }
  });

  await logAction(
    { userId: actor?.id ?? null, action: 'bank.import', entityType: 'bank_account', entityId: bankAccountId, details: { source, inserted, skipped } },
    x,
  );
  return { inserted, skipped };
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
    `SELECT bt.*, COALESCE(p.check_number, p.reference, p.batch_number) AS matched_check_number
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
