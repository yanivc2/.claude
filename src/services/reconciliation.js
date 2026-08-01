import { getExecutor, tx } from '../db/adapter.js';
import { config } from '../config.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { getTransaction } from './bankTransactions.js';
import { logAction } from './audit.js';

// R7 — reconcile a bank debit against an open (issued) check. Matches on same account + same
// amount + payment_date within reconcileWindowDays of the transaction date + debit direction.

function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Open checks that could correspond to a given (debit) transaction.
 * @returns {{candidates: Array, deterministic: object|null}}
 */
export async function findCandidates(txn, x = getExecutor()) {
  if (txn.amount >= 0) return { candidates: [], deterministic: null }; // credits don't clear checks
  const matchAmount = Math.abs(txn.amount);
  const w = config.rules.reconcileWindowDays;
  const lo = addDaysIso(txn.txn_date, -w);
  const hi = addDaysIso(txn.txn_date, w);

  const candidates = await x.many(
    `SELECT * FROM payments
      WHERE bank_account_id = ? AND status = 'issued' AND amount = ?
        AND payment_date BETWEEN ? AND ?
      ORDER BY payment_date`,
    [txn.bank_account_id, matchAmount, lo, hi],
  );

  const ref = (txn.raw_reference ?? '').trim();
  const haystack = `${txn.description ?? ''} ${txn.raw_reference ?? ''}`;
  const ids = (p) => [p.check_number, p.reference, p.batch_number].filter(Boolean);
  const deterministic =
    (ref && candidates.find((p) => ids(p).some((v) => v === ref))) ||
    candidates.find((p) => ids(p).some((v) => haystack.includes(v))) ||
    null;

  return { candidates, deterministic };
}

/** Human-facing classification of a transaction's match state (for the reconciliation UI). */
export async function classify(txn, x = getExecutor()) {
  const { candidates, deterministic } = await findCandidates(txn, x);
  if (deterministic) return { state: 'deterministic', candidates, suggestion: deterministic };
  if (candidates.length === 1) return { state: 'single', candidates, suggestion: candidates[0] };
  if (candidates.length > 1) return { state: 'ambiguous', candidates, suggestion: null };
  return { state: 'none', candidates, suggestion: null };
}

/**
 * Confirm a match: link the transaction to the check and mark the check cleared (R7).
 */
export async function confirmMatch(txnId, paymentId, actor, x = getExecutor()) {
  const txn = await getTransaction(txnId, x);
  if (txn.matched_payment_id) throw new RuleError('R7', 'תנועה זו כבר הותאמה');

  const payment = await x.one('SELECT * FROM payments WHERE id = ?', [paymentId]);
  if (!payment) throw new NotFoundError(`תשלום ${paymentId} לא נמצא`);
  if (payment.status !== 'issued') throw new RuleError('R7', `הצ׳ק אינו פתוח (status=${payment.status})`);
  if (payment.bank_account_id !== txn.bank_account_id) {
    throw new RuleError('R7', 'התנועה והצ׳ק שייכים לחשבונות בנק שונים');
  }
  if (payment.amount !== Math.abs(txn.amount)) {
    throw new RuleError('R7', 'סכום התנועה אינו תואם לסכום הצ׳ק');
  }

  await tx(async (t) => {
    await t.run('UPDATE bank_transactions SET matched_payment_id = ? WHERE id = ?', [paymentId, txnId]);
    await t.run("UPDATE payments SET status = 'cleared', cleared_date = ? WHERE id = ?", [txn.txn_date, paymentId]);
    await logAction(
      { userId: actor?.id ?? null, action: 'reconcile.match', entityType: 'payment', entityId: paymentId, details: { txnId, clearedDate: txn.txn_date } },
      t,
    );
  });

  return { txnId, paymentId, clearedDate: txn.txn_date };
}

/** Undo a match: unlink the transaction and return the check to `issued`. */
export async function unmatch(txnId, actor, x = getExecutor()) {
  const txn = await getTransaction(txnId, x);
  if (!txn.matched_payment_id) throw new RuleError('R7', 'לתנועה זו אין התאמה לביטול');
  const paymentId = txn.matched_payment_id;
  await tx(async (t) => {
    await t.run('UPDATE bank_transactions SET matched_payment_id = NULL WHERE id = ?', [txnId]);
    await t.run("UPDATE payments SET status = 'issued', cleared_date = NULL WHERE id = ?", [paymentId]);
    await logAction(
      { userId: actor?.id ?? null, action: 'reconcile.unmatch', entityType: 'payment', entityId: paymentId, details: { txnId } },
      t,
    );
  });
  return { txnId, paymentId };
}

/**
 * Auto-reconcile every unmatched debit on an account.
 * @returns {{matched:number, ambiguous:number, unmatched:number}}
 */
export async function autoReconcile(bankAccountId, actor, x = getExecutor()) {
  const txns = await x.many(
    `SELECT * FROM bank_transactions
      WHERE bank_account_id = ? AND matched_payment_id IS NULL AND amount < 0
      ORDER BY txn_date`,
    [bankAccountId],
  );

  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  for (const txn of txns) {
    const { state, suggestion } = await classify(txn, x);
    if ((state === 'deterministic' || state === 'single') && suggestion) {
      await confirmMatch(txn.id, suggestion.id, actor, x);
      matched += 1;
    } else if (state === 'ambiguous') {
      ambiguous += 1;
    } else {
      unmatched += 1;
    }
  }

  await logAction(
    { userId: actor?.id ?? null, action: 'reconcile.auto', entityType: 'bank_account', entityId: bankAccountId, details: { matched, ambiguous, unmatched } },
    x,
  );
  return { matched, ambiguous, unmatched };
}
