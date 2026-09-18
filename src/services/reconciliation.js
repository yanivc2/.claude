import { addDaysIso } from '../lib/loginHours.js';
import { getExecutor, tx } from '../db/adapter.js';
import { config } from '../config.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeWhere } from '../lib/scope.js';
import { notify } from '../lib/notify.js';
import { getTransaction } from './bankTransactions.js';
import { bagReferences } from './deposits.js';
import { plainNumber } from '../lib/numText.js';
import { logAction } from './audit.js';

// R7 — reconcile a bank debit against an open (issued) check. Matches on same account + same
// amount + payment_date within reconcileWindowDays of the transaction date + debit direction.

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
  // …and the standing sweep over every voided check: the six-month clock, the missing cash match,
  // the missing link. Idempotent (payments.void_alerted), so re-running a reconcile stays quiet
  // unless something actually changed. See services/voidedChecks.js.
  try {
    const { alertOnVoidedChecks, alertOnExpiredNotCollected } = await import('./voidedChecks.js');
    await alertOnVoidedChecks(x);
    await alertOnExpiredNotCollected(x);
    // …and the transfer watch: a fresh statement is exactly when an undocumented transfer becomes
    // visible, so this is the first moment it can be reported (services/transfers.js).
    const { alertOnUntrackedTransfers, alertOnTransferProblems } = await import('./transfers.js');
    await alertOnUntrackedTransfers(x);
    await alertOnTransferProblems(x);
    // …וצ׳ק שכר שנפרע בבנק לפני שהותאם להוצאת מזומן: דף בנק טרי הוא בדיוק הרגע שבו הפירעון
    // נעשה ידוע, ולכן זו ההזדמנות הראשונה לומר עליו (services/salaryPayments.js).
    const { alertOnSalaryChecksClearedBeforeMatch } = await import('./salaryPayments.js');
    await alertOnSalaryChecksClearedBeforeMatch(x);
  } catch { /* an alert must never fail a reconcile */ }

  await logAction(
    { userId: actor?.id ?? null, action: 'reconcile.auto', entityType: 'bank_account', entityId: bankAccountId, details: { matched, ambiguous, unmatched, voidedSeen: voidedSeen.length } },
    x,
  );
  return { matched, ambiguous, unmatched, voidedSeen: voidedSeen.length };
}

/**
 * **התאמה מלאה של חשבון** — צ׳קים *וגם* הפקדות. זה מה שכל מסלול צריך לקרוא.
 *
 * 🔴 למה זה קיים: `reconcileDeposits` נקרא בעבר **רק** מכפתור "התאמה אוטומטית" בדף המרקורים.
 * לא מדף התאמת הבנק (שם הכפתור באותו שם עשה רק צ׳קים), לא ממשיכת הבנקאות הפתוחה, ולא מהסריקה
 * הלילית. כלומר הפקדה נקשרה לשורת הבנק שלה רק אם הבעלים במקרה לחץ על הכפתור הנכון מבין השניים —
 * ומי שלחץ על השני קיבל "הותאמו 0" ולא ידע למה. מי שמוסיף מסלול ייבוא חדש קורא לזה, ולא לשניים.
 *
 * מחזיר את אותם שדות של `autoReconcile` (ולכן קוראים ותיקים ממשיכים לעבוד) בתוספת `deposits`.
 */
export async function reconcileAccount(bankAccountId, actor, x = getExecutor()) {
  const checks = await autoReconcile(bankAccountId, actor, x);
  const dep = await reconcileDeposits(bankAccountId, actor, x);
  return { ...checks, deposits: dep.matched };
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
    `SELECT * FROM bank_transactions WHERE bank_account_id = ? AND amount > 0 ORDER BY txn_date, id`,
    [bankAccountId],
  );
  // Credit lines already used for a deposit match (filtered in JS — pg-mem can't run the
  // correlated NOT EXISTS this would otherwise need).
  const usedRows = await x.many('SELECT matched_txn_id FROM deposits WHERE matched_txn_id IS NOT NULL', []);
  const used = new Set(usedRows.map((r) => Number(r.matched_txn_id)));

  // 🔴 מונע **מההפקדה** ולא מהתנועה. הפקדה אחת יכולה לשאת כמה שקיות בשדה אחד
  // (`216404173+216404174`), והבנק מזכה שורה לכל שקית; לולאה על התנועות עם השוואת מחרוזת מלאה
  // לא הייתה מוצאת אף אחת מהן, וההפקדה נשארה לא-מותאמת לנצח — בלי תאריך סטטוס ובלי אימות ספירה.
  const deposits = await x.many(
    `SELECT * FROM deposits WHERE store_id = ? AND matched_txn_id IS NULL ORDER BY deposit_date, id`,
    [acc.store_id],
  );
  const refOf = (t) => plainNumber(String(t.raw_reference ?? '').trim());
  let matched = 0;
  for (const dep of deposits) {
    const refs = new Set(bagReferences(dep.bag_number));
    if (!refs.size) continue;
    // 🔴 **שורת הזיכוי הראשונה בלבד לכל אסמכתה.** הבנק כותב אחריה שורות "תיקון" — ביטול וזיכוי
    // מחדש — עם אותה אסמכתה בדיוק. לקיחת כל השורות החיוביות סופרת גם את הזיכוי-מחדש, ואז
    // `recon_diff` יצא בגובה הפקדה שלמה (נמדד: +68,220 במקום 0). התיקונים נספרים בנפרד,
    // בעמודת "אימות ספירה" (services/deposits.js#depositVerifications).
    const firstPerRef = new Map();
    for (const t of txns) {
      if (used.has(Number(t.id))) continue;
      const r = refOf(t);
      if (!refs.has(r) || firstPerRef.has(r)) continue;
      firstPerRef.set(r, t); // txns כבר ממוין לפי txn_date, id
    }
    const lines = [...firstPerRef.values()];
    if (!lines.length) continue;
    // כל השקיות יחד מול הסכום שהוצהר — אחרת הפקדה של שתי שקיות תיראה כחצי חסרה.
    const total = lines.reduce((n, t) => n + (Number(t.amount) || 0), 0);
    const diff = total - dep.amount;
    await x.run(
      'UPDATE deposits SET matched_txn_id = ?, recon_diff = ?, deposited = 1 WHERE id = ?',
      [lines[0].id, diff, dep.id],
    );
    await logAction(
      { userId: actor?.id ?? null, action: 'reconcile.deposit', entityType: 'deposit', entityId: dep.id,
        details: { txnIds: lines.map((t) => t.id), bags: [...refs], diff } },
      x,
    );
    for (const t of lines) used.add(Number(t.id));
    matched += 1;
  }
  return { matched };
}

/**
 * התאם תנועת בנק ל**חשבונית אחת או לכמה** — חיוב שיצא מהבנק בלי שנרשם כאן תשלום.
 *
 * זה המקרה של העברה/הוראת קבע/חיוב ישיר שהספק גבה: הכסף עזב את הבנק, החשבוניות יושבות "לתשלום",
 * ואין צ׳ק להתאים אליו — ולכן עד עכשיו השורה אמרה "אין צ׳ק פתוח תואם" ולא הייתה שום דרך לסגור
 * אותה. התוצאה הייתה חשבונית שנשארת פתוחה אחרי שכבר שולמה, כלומר מועמדת להיות משולמת פעם שנייה.
 *
 * 🔴 **נרשם כתשלום אמיתי ולא כקישור-תצוגה.** `syncInvoicePaidStatus` הוא המקום היחיד שמחליט
 * `paid`, והוא נגזר מ-`payment_lines` — קישור שאינו עובר דרך תשלום היה משאיר את החשבונית פתוחה
 * בדיוק כמו קודם, רק עם מראה של טיפול. לכן: נוצר תשלום בסכום **שיצא מהבנק בפועל** (לא בסכום
 * החשבוניות), הוא מוקצה על פני החשבוניות דרך `payInvoices` (אותו R8, זיכויים ראשונים), והתנועה
 * מקושרת אליו כמו כל התאמה אחרת — כך ש"בטל התאמה" עובד בלי קוד נוסף.
 *
 * @param {number} txnId
 * @param {number[]} invoiceIds
 * @param {{method?:string, reference?:string}} opts
 * @returns {Promise<{txnId:number, paymentId:number, allocated:number, stillOpen:number}>}
 */
export async function matchTxnToInvoices(txnId, invoiceIds, opts, actor, x = getExecutor()) {
  const txn = await getTransaction(txnId, x);
  if (txn.matched_payment_id) throw new RuleError('R7', 'תנועה זו כבר הותאמה');
  // חיוב בלבד: זיכוי בבנק אינו תשלום לספק, ושיוכו לחשבונית היה רושם תשלום שלא קרה.
  if (Number(txn.amount) >= 0) {
    throw new RuleError('R7', 'רק תנועת חובה (כסף שיצא) ניתנת לשיוך לחשבוניות.');
  }
  const ids = [].concat(invoiceIds || []).map(Number).filter(Boolean);
  if (!ids.length) throw new RuleError('R', 'לא נבחרו חשבוניות');

  // כל החשבוניות חייבות להיות של חשבון הבנק הזה — כלומר של החנות שממנה יצא הכסף. בלי זה חיוב
  // בסניף אחד היה סוגר חשבונית של סניף אחר, והספרים של שניהם יוצאים שגויים.
  const rows = [];
  for (const id of ids) {
    const inv = await x.one(
      `SELECT i.id, i.invoice_number, i.supplier_id, i.store_id, ba.id AS bank_account_id
         FROM invoices i LEFT JOIN bank_accounts ba ON ba.store_id = i.store_id
        WHERE i.id = ?`,
      [id],
    );
    if (!inv) throw new NotFoundError(`חשבונית ${id} לא נמצאה`);
    if (Number(inv.bank_account_id) !== Number(txn.bank_account_id)) {
      throw new RuleError(
        'R7',
        `חשבונית ${inv.invoice_number || inv.id} שייכת לחנות אחרת מזו של חשבון הבנק — לא ניתן לשייך אליה חיוב מהחשבון הזה.`,
      );
    }
    rows.push(inv);
  }

  // התשלום נרשם על ספק אחד. ספקים שונים באותו חיוב = לא ניתן לדעת למי שולם, ולכן סירוב מפורש
  // ולא ניחוש לפי הראשונה.
  const suppliers = [...new Set(rows.map((r) => Number(r.supplier_id)))];
  if (suppliers.length > 1) {
    throw new RuleError('R8', 'החשבוניות שנבחרו שייכות לכמה ספקים. בחר חשבוניות של ספק אחד — חיוב אחד בבנק הוא תשלום לספק אחד.');
  }

  const { payInvoices } = await import('./payments.js');
  const { payment, allocated, stillOpen } = await payInvoices(
    {
      bankAccountId: txn.bank_account_id,
      method: opts?.method || 'transfer',
      reference: opts?.reference || txn.raw_reference || null,
      paymentDate: txn.txn_date,
      invoiceIds: ids,
      supplierId: suppliers[0],
      amount: Math.abs(Number(txn.amount)),
    },
    actor,
    x,
  );

  await tx(async (t) => {
    await t.run('UPDATE bank_transactions SET matched_payment_id = ? WHERE id = ?', [payment.id, txnId]);
    await t.run("UPDATE payments SET status = 'cleared', cleared_date = ? WHERE id = ?", [txn.txn_date, payment.id]);
    await logAction(
      {
        userId: actor?.id ?? null,
        action: 'reconcile.match_invoices',
        entityType: 'payment',
        entityId: payment.id,
        details: { txnId, invoiceIds: ids, amount: Math.abs(Number(txn.amount)), stillOpen },
      },
      t,
    );
  });

  return { txnId, paymentId: payment.id, allocated, stillOpen };
}
