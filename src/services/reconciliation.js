import { getExecutor, tx } from '../db/adapter.js';
import { config } from '../config.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeWhere } from '../lib/scope.js';
import { notify } from '../lib/notify.js';
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

/**
 * Unmatched bank debits on an account that correspond to a VOIDED payment — same amount AND the
 * voided check's identifier (check number / reference / batch) appears in the bank line's text.
 * A check that was voided in the software but still cleared the bank: money left the account, so
 * it needs human attention (the void was wrong, or the check must be re-issued/stop-payment).
 * @returns {Promise<Array<{txn:object, payment:object}>>}
 */
export async function voidedCheckHits(bankAccountId, x = getExecutor()) {
  const voided = await x.many(
    "SELECT id, check_number, reference, batch_number, amount FROM payments WHERE bank_account_id = ? AND status = 'voided'",
    [bankAccountId],
  );
  if (!voided.length) return [];
  const debits = await x.many(
    'SELECT * FROM bank_transactions WHERE bank_account_id = ? AND matched_payment_id IS NULL AND amount < 0',
    [bankAccountId],
  );
  const hits = [];
  for (const t of debits) {
    const ref = (t.raw_reference ?? '').trim();
    const text = `${t.description ?? ''} ${t.raw_reference ?? ''}`;
    const v = voided.find(
      (p) =>
        p.amount === Math.abs(t.amount) &&
        [p.check_number, p.reference, p.batch_number].filter(Boolean).some((id) => id === ref || text.includes(id)),
    );
    if (v) hits.push({ txn: t, payment: v });
  }
  return hits;
}

/**
 * Dashboard signal: voided checks seen in the bank, across the caller's authorized accounts
 * (company + store scope, plus the active-store filter). { count, rows }.
 */
export async function voidedChecksSeenInBank(scope = null, storeId = null, x = getExecutor()) {
  const sc = scopeWhere(scope, 'company_id', 'store_id');
  const st = storeId ? ' AND store_id = ?' : '';
  const accts = await x.many(
    `SELECT id FROM bank_accounts WHERE 1 = 1${sc.sql}${st}`,
    [...sc.params, ...(storeId ? [storeId] : [])],
  );
  let count = 0;
  const rows = [];
  for (const a of accts) {
    const hits = await voidedCheckHits(a.id, x);
    count += hits.length;
    rows.push(...hits);
  }
  return { count, rows };
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

  // Alert: a voided check that nonetheless shows up as a bank debit (money left the account).
  const voidedSeen = await voidedCheckHits(bankAccountId, x);
  if (voidedSeen.length) {
    const lines = voidedSeen.map(
      (h) => `• צ׳ק ${h.payment.check_number || h.payment.reference || ''} · ${Math.abs(h.txn.amount) / 100} ₪ · ${h.txn.txn_date}`,
    );
    notify(`⚠️ <b>צ׳ק מבוטל הופיע בדף הבנק</b>\n${lines.join('\n')}\nהכסף עבר — יש לבדוק (ביטול שגוי / stop-payment / הנפקה מחדש).`);
  }

  await logAction(
    { userId: actor?.id ?? null, action: 'reconcile.auto', entityType: 'bank_account', entityId: bankAccountId, details: { matched, ambiguous, unmatched, voidedSeen: voidedSeen.length } },
    x,
  );
  return { matched, ambiguous, unmatched, voidedSeen: voidedSeen.length };
}

/**
 * Reconcile bank credit lines against deposit declarations (הפקדות) of the account's store.
 * A deposit's bag number is the bank reference (מספר שקית = מספר אסמכתה); the amounts may differ,
 * so we record recon_diff = bank amount − declared amount (יתרה>0 / חוסר<0) rather than requiring
 * an exact match. Each credit line and each deposit is used at most once.
 * @returns {{matched:number}}
 */
export async function reconcileDeposits(bankAccountId, actor, x = getExecutor()) {
  const acc = await x.one('SELECT id, store_id FROM bank_accounts WHERE id = ?', [bankAccountId]);
  if (!acc) return { matched: 0 };
  const txns = await x.many(
    `SELECT * FROM bank_transactions WHERE bank_account_id = ? AND amount > 0 ORDER BY txn_date`,
    [bankAccountId],
  );
  // Credit lines already used for a deposit match (filtered in JS — pg-mem can't run the
  // correlated NOT EXISTS this would otherwise need).
  const usedRows = await x.many('SELECT matched_txn_id FROM deposits WHERE matched_txn_id IS NOT NULL', []);
  const used = new Set(usedRows.map((r) => Number(r.matched_txn_id)));
  let matched = 0;
  for (const txn of txns) {
    if (used.has(Number(txn.id))) continue;
    const ref = (txn.raw_reference ?? '').trim();
    if (!ref) continue;
    const dep = await x.one(
      `SELECT * FROM deposits
         WHERE store_id = ? AND matched_txn_id IS NULL AND bag_number = ?
         ORDER BY deposit_date LIMIT 1`,
      [acc.store_id, ref],
    );
    if (!dep) continue;
    const diff = txn.amount - dep.amount;
    await x.run(
      'UPDATE deposits SET matched_txn_id = ?, recon_diff = ?, deposited = 1 WHERE id = ?',
      [txn.id, diff, dep.id],
    );
    await logAction(
      { userId: actor?.id ?? null, action: 'reconcile.deposit', entityType: 'deposit', entityId: dep.id, details: { txnId: txn.id, diff } },
      x,
    );
    used.add(Number(txn.id));
    matched += 1;
  }
  return { matched };
}
