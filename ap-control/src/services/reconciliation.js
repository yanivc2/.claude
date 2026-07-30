import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { getTransaction } from './bankTransactions.js';
import { logAction } from './audit.js';

// R7 — reconcile a bank debit against an open (issued) check.
//
// The brief (§11.1) does NOT assume the check number is available in the scraped data, so the
// engine matches on: same bank account + same amount + payment_date within reconcileWindowDays
// of the transaction date + debit direction. Resolution per transaction:
//   - a candidate whose check_number appears in the transaction text  -> deterministic match (bonus)
//   - exactly one candidate                                           -> auto-match
//   - more than one candidate                                         -> ambiguous, flagged for the secretary
//   - none                                                            -> left unmatched

/**
 * Open checks that could correspond to a given (debit) transaction.
 * @returns {{candidates: Array, deterministic: object|null}}
 */
export function findCandidates(txn, db = getDb()) {
  if (txn.amount >= 0) return { candidates: [], deterministic: null }; // credits don't clear checks
  const matchAmount = Math.abs(txn.amount);

  const candidates = db
    .prepare(
      `SELECT * FROM payments
        WHERE bank_account_id = ? AND status = 'issued' AND amount = ?
          AND ABS(julianday(payment_date) - julianday(?)) <= ?
        ORDER BY payment_date`,
    )
    .all(txn.bank_account_id, matchAmount, txn.txn_date, config.rules.reconcileWindowDays);

  // Deterministic bonus: if the check number is present in the transaction text, prefer it.
  const haystack = `${txn.description ?? ''} ${txn.raw_reference ?? ''}`;
  const deterministic =
    candidates.find((p) => p.check_number && haystack.includes(p.check_number)) || null;

  return { candidates, deterministic };
}

/** Human-facing classification of a transaction's match state (for the reconciliation UI). */
export function classify(txn, db = getDb()) {
  const { candidates, deterministic } = findCandidates(txn, db);
  if (deterministic) return { state: 'deterministic', candidates, suggestion: deterministic };
  if (candidates.length === 1) return { state: 'single', candidates, suggestion: candidates[0] };
  if (candidates.length > 1) return { state: 'ambiguous', candidates, suggestion: null };
  return { state: 'none', candidates, suggestion: null };
}

/**
 * Confirm a match: link the transaction to the check and mark the check cleared with the
 * transaction date (R7). Validates account + amount + that neither side is already taken.
 */
export function confirmMatch(txnId, paymentId, actor, db = getDb()) {
  const txn = getTransaction(txnId, db);
  if (txn.matched_payment_id) throw new RuleError('R7', 'תנועה זו כבר הותאמה');

  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) throw new NotFoundError(`תשלום ${paymentId} לא נמצא`);
  if (payment.status !== 'issued') throw new RuleError('R7', `הצ׳ק אינו פתוח (status=${payment.status})`);
  if (payment.bank_account_id !== txn.bank_account_id) {
    throw new RuleError('R7', 'התנועה והצ׳ק שייכים לחשבונות בנק שונים');
  }
  if (payment.amount !== Math.abs(txn.amount)) {
    throw new RuleError('R7', 'סכום התנועה אינו תואם לסכום הצ׳ק');
  }

  db.transaction(() => {
    db.prepare('UPDATE bank_transactions SET matched_payment_id = ? WHERE id = ?').run(paymentId, txnId);
    db.prepare("UPDATE payments SET status = 'cleared', cleared_date = ? WHERE id = ?").run(
      txn.txn_date,
      paymentId,
    );
    logAction(
      { userId: actor?.id ?? null, action: 'reconcile.match', entityType: 'payment', entityId: paymentId, details: { txnId, clearedDate: txn.txn_date } },
      db,
    );
  })();

  return { txnId, paymentId, clearedDate: txn.txn_date };
}

/** Undo a match: unlink the transaction and return the check to `issued`. */
export function unmatch(txnId, actor, db = getDb()) {
  const txn = getTransaction(txnId, db);
  if (!txn.matched_payment_id) throw new RuleError('R7', 'לתנועה זו אין התאמה לביטול');
  const paymentId = txn.matched_payment_id;
  db.transaction(() => {
    db.prepare('UPDATE bank_transactions SET matched_payment_id = NULL WHERE id = ?').run(txnId);
    db.prepare("UPDATE payments SET status = 'issued', cleared_date = NULL WHERE id = ?").run(paymentId);
    logAction(
      { userId: actor?.id ?? null, action: 'reconcile.unmatch', entityType: 'payment', entityId: paymentId, details: { txnId } },
      db,
    );
  })();
  return { txnId, paymentId };
}

/**
 * Auto-reconcile every unmatched debit on an account: deterministic and single-candidate
 * transactions are matched automatically; ambiguous ones are left for the secretary to decide.
 * @returns {{matched:number, ambiguous:number, unmatched:number}}
 */
export function autoReconcile(bankAccountId, actor, db = getDb()) {
  const txns = db
    .prepare(
      `SELECT * FROM bank_transactions
        WHERE bank_account_id = ? AND matched_payment_id IS NULL AND amount < 0
        ORDER BY txn_date`,
    )
    .all(bankAccountId);

  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  for (const txn of txns) {
    const { state, suggestion } = classify(txn, db);
    if ((state === 'deterministic' || state === 'single') && suggestion) {
      confirmMatch(txn.id, suggestion.id, actor, db);
      matched += 1;
    } else if (state === 'ambiguous') {
      ambiguous += 1;
    } else {
      unmatched += 1;
    }
  }

  logAction(
    { userId: actor?.id ?? null, action: 'reconcile.auto', entityType: 'bank_account', entityId: bankAccountId, details: { matched, ambiguous, unmatched } },
    db,
  );
  return { matched, ambiguous, unmatched };
}
