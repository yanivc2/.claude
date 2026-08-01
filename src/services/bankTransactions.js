import { getDb } from '../db/index.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

// Stage 2: bank transactions land here (from the scraper, a CSV export, or manual entry)
// and are then reconciled against open checks by the R7 engine. Amounts are signed agorot
// — a debit (charge, e.g. a cleared check) is negative, matching the scraper's chargedAmount.

/**
 * Import a batch of transactions for one bank account. Idempotent: a transaction identical
 * on (txn_date, amount, description, raw_reference) is skipped, so re-importing an overlapping
 * date range does not create duplicates.
 *
 * @param {number} bankAccountId
 * @param {Array<{txnDate:string, amount:number, description?:string, rawReference?:string}>} rows
 * @param {string} source  e.g. 'scraper' | 'csv' | 'manual'
 * @param {object} actor
 * @returns {{inserted:number, skipped:number}}
 */
export function importTransactions(bankAccountId, rows, source, actor, db = getDb()) {
  const account = db.prepare('SELECT id FROM bank_accounts WHERE id = ?').get(bankAccountId);
  if (!account) throw new NotFoundError(`חשבון בנק ${bankAccountId} לא נמצא`);

  const exists = db.prepare(
    `SELECT id FROM bank_transactions
      WHERE bank_account_id = ? AND txn_date = ? AND amount = ?
        AND IFNULL(description,'') = IFNULL(?, '') AND IFNULL(raw_reference,'') = IFNULL(?, '')`,
  );
  const insert = db.prepare(
    `INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let inserted = 0;
  let skipped = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      if (!r || !r.txnDate || !Number.isFinite(r.amount)) {
        throw new RuleError('VALIDATION', 'שורת תנועה לא תקינה (חסר תאריך או סכום)');
      }
      const desc = r.description ?? null;
      const ref = r.rawReference ?? null;
      if (exists.get(bankAccountId, r.txnDate, r.amount, desc, ref)) {
        skipped += 1;
        continue;
      }
      insert.run(bankAccountId, r.txnDate, r.amount, desc, ref, source);
      inserted += 1;
    }
  });
  run();

  logAction(
    { userId: actor?.id ?? null, action: 'bank.import', entityType: 'bank_account', entityId: bankAccountId, details: { source, inserted, skipped } },
    db,
  );
  return { inserted, skipped };
}

/** Unmatched debit transactions for an account (candidates for check reconciliation). */
export function listUnmatched(bankAccountId, db = getDb()) {
  return db
    .prepare(
      `SELECT * FROM bank_transactions
        WHERE bank_account_id = ? AND matched_payment_id IS NULL AND amount < 0
        ORDER BY txn_date`,
    )
    .all(bankAccountId);
}

/** All transactions for an account, newest first, with any matched check number joined. */
export function listTransactions(bankAccountId, db = getDb()) {
  return db
    .prepare(
      `SELECT bt.*, COALESCE(p.check_number, p.reference, p.batch_number) AS matched_check_number
         FROM bank_transactions bt
         LEFT JOIN payments p ON p.id = bt.matched_payment_id
        WHERE bt.bank_account_id = ?
        ORDER BY bt.txn_date DESC, bt.id DESC`,
    )
    .all(bankAccountId);
}

export function getTransaction(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`תנועת בנק ${id} לא נמצאה`);
  return row;
}
