// "צ'קים מבוטלים" — a voided check is not a closed matter.
//
// THE RISK THIS PAGE EXISTS FOR: in Israel a check stays presentable for SIX MONTHS from its date.
// Voiding it in the software tells our books it will not be paid; it tells the bank nothing. If the
// holder walks into a branch four months later the money leaves the account, and nothing in the
// books is expecting it. So every voided check is tracked until it is genuinely safe, and the
// status column is the answer to one question: could this still be cashed, and was it?
//
// The four reasons a check gets voided each carry their own follow-up, which is why the reason is
// asked for at void time rather than being free text:
//   • לא נאסף (not_collected)      — nobody came for it. Safe once six months have passed; until
//                                    then it is live, and at the six-month mark the owner is told.
//   • נפרע במזומן עבור שכר         — the employee cashed it at the till. MUST be matched to the
//     (cashed_for_salary)            Z-closing cash expense that paid it, or the same wage is paid
//                                    twice; an unmatched one is chased.
//   • שינוי אמצעי תשלום            — re-issued by another means. Links to the replacement, so the
//     (method_changed)               supplier is never left looking unpaid.
//   • ביטול שורה בתוכנה            — a data-entry correction. Links to the row it belonged to.
//     (row_cancelled)
import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeWhere } from '../lib/scope.js';
import { addDaysIso, israelToday } from '../lib/loginHours.js';
import { notify } from '../lib/notify.js';

export const VOID_REASONS = [
  { value: 'not_collected', label: 'לא נאסף', hint: 'הצ׳ק לא נאסף. יישאר בר-פירעון עד חצי שנה מתאריך הפירעון.' },
  { value: 'cashed_for_salary', label: 'נפרע במזומן עבור שכר', hint: 'העובד פרט את הצ׳ק בקופה — חובה להתאים להוצאת מזומן בסגירת Z.' },
  { value: 'method_changed', label: 'שינוי אמצעי תשלום', hint: 'שולם מחדש באמצעי אחר — יש לקשר לתשלום החדש.' },
  { value: 'row_cancelled', label: 'ביטול שורה בתוכנה', hint: 'תיקון הזנה — יש לקשר לשורה שבוטלה (חשבונית או תשלום).' },
];
export const VOID_REASON_VALUES = VOID_REASONS.map((r) => r.value);
export const voidReasonLabel = (v) => (VOID_REASONS.find((r) => r.value === v) || {}).label || v || '—';

/** A check is presentable for six months from its date — that is the whole clock on this page. */
export const CHECK_LIFE_DAYS = 182;

/**
 * The status of one voided check: can it still be cashed, and has it been?
 *
 * `cashed` is the alarm — a voided check that a bank movement matched anyway. Everything else is a
 * countdown: `live` while the six months run, `expired` once they have, and the two reason-specific
 * problems (`unmatched`, `unlinked`) when the follow-up its reason demands was never done.
 */
export function checkStatus(row, today = israelToday()) {
  if (row.cashed_after_void) {
    return { key: 'cashed', label: 'נפרע אחרי הביטול!', badge: 'b-blocked', alarm: true };
  }
  const safeFrom = addDaysIso(row.payment_date, CHECK_LIFE_DAYS);
  const expired = today >= safeFrom;
  if (row.void_reason === 'cashed_for_salary' && !row.void_cash_expense_id) {
    return { key: 'unmatched', label: 'ללא התאמה להוצאת מזומן', badge: 'b-on_hold', alarm: true, safeFrom };
  }
  if (row.void_reason === 'method_changed' && !row.void_link_payment_id) {
    return { key: 'unlinked', label: 'ללא קישור לתשלום החדש', badge: 'b-on_hold', alarm: true, safeFrom };
  }
  if (row.void_reason === 'row_cancelled' && !row.void_link_invoice_id && !row.void_link_payment_id) {
    return { key: 'unlinked', label: 'ללא קישור לשורה שבוטלה', badge: 'b-on_hold', alarm: true, safeFrom };
  }
  if (expired) return { key: 'expired', label: 'עבר תוקף — בטוח', badge: 'b-cleared', safeFrom };
  return { key: 'live', label: `בר-פירעון עד ${safeFrom}`, badge: 'b-neutral', safeFrom };
}

/**
 * Every voided check the caller may see, grouped per store — one rubric per branch, which is how
 * the page is read. A voided check keeps its bank account, so the store comes from there.
 *
 * `cashed_after_void` is computed here rather than stored: a bank transaction that names this
 * payment is the evidence, and it can appear at any later import.
 */
export async function listVoidedChecks({ scope = null } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  const rows = await x.many(
    `SELECT p.id, p.check_number, p.payment_date, p.amount, p.void_reason, p.voided_at,
            p.void_link_payment_id, p.void_link_invoice_id, p.void_cash_expense_id,
            p.supplier_id, ba.store_id AS store_id, ba.display_name AS account_name,
            st.name AS store_name, c.name AS company_name,
            u.name AS voided_by_name, s.name AS supplier_name
       FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
       JOIN stores st ON st.id = ba.store_id
       JOIN companies c ON c.id = ba.company_id
       LEFT JOIN users u ON u.id = p.voided_by
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.status = 'voided' AND p.method = 'check'${sc.sql}
      ORDER BY p.voided_at DESC, p.id DESC`,
    [...sc.params],
  );
  if (!rows.length) return [];

  // Which of them the bank paid ANYWAY. Two kinds of evidence, and both count:
  //   • an explicit match (matched_payment_id) — rare on a voided check, but possible if it was
  //     voided after being matched;
  //   • an unmatched debit that carries the check's number and amount — which is what a voided
  //     check actually looks like when it is presented, since nothing links it to us.
  // The second is `voidedCheckHits` in services/reconciliation.js; the same rule is applied here
  // across all accounts, so the page and the alert never disagree.
  const cashed = new Set(
    (await x.many('SELECT DISTINCT matched_payment_id FROM bank_transactions WHERE matched_payment_id IS NOT NULL', []))
      .map((r) => Number(r.matched_payment_id)),
  );
  const debits = await x.many(
    'SELECT bank_account_id, amount, description, raw_reference FROM bank_transactions WHERE matched_payment_id IS NULL AND amount < 0',
    [],
  );
  const payAccounts = await x.many(
    "SELECT id, bank_account_id, check_number, amount FROM payments WHERE status = 'voided' AND method = 'check'",
    [],
  );
  for (const p of payAccounts) {
    const num = (p.check_number ?? '').trim();
    if (!num) continue;
    const hit = debits.some(
      (t) =>
        Number(t.bank_account_id) === Number(p.bank_account_id) &&
        Number(p.amount) === Math.abs(Number(t.amount)) &&
        (String(t.raw_reference ?? '').trim() === num || `${t.description ?? ''} ${t.raw_reference ?? ''}`.includes(num)),
    );
    if (hit) cashed.add(Number(p.id));
  }
  const lines = await x.many(
    `SELECT pl.payment_id, i.invoice_number, sup.name AS supplier_name
       FROM payment_lines pl
       JOIN invoices i ON i.id = pl.invoice_id
       JOIN suppliers sup ON sup.id = i.supplier_id`,
    [],
  );
  const forWhom = new Map();
  for (const l of lines) {
    const k = Number(l.payment_id);
    if (!forWhom.has(k)) forWhom.set(k, []);
    forWhom.get(k).push(`${l.supplier_name} · ${l.invoice_number}`);
  }
  const salary = await x.many(
    `SELECT sp.payment_id, e.first_name, e.last_name
       FROM salary_payments sp JOIN employees e ON e.id = sp.employee_id
      WHERE sp.payment_id IS NOT NULL`,
    [],
  );
  for (const s of salary) {
    const k = Number(s.payment_id);
    if (!forWhom.has(k)) forWhom.set(k, []);
    forWhom.get(k).push(`שכר · ${s.first_name} ${s.last_name}`);
  }

  const today = israelToday();
  const enriched = rows.map((r) => {
    const row = { ...r, cashed_after_void: cashed.has(Number(r.id)) };
    const forText = (forWhom.get(Number(r.id)) || []).join(' · ') || r.supplier_name || '—';
    return { ...row, for_text: forText, status: checkStatus(row, today) };
  });

  // One rubric per store, in the order the pages elsewhere use (company, then store).
  const byStore = new Map();
  for (const r of enriched) {
    const k = Number(r.store_id);
    if (!byStore.has(k)) {
      byStore.set(k, { storeId: k, storeName: r.store_name, companyName: r.company_name, rows: [] });
    }
    byStore.get(k).rows.push(r);
  }
  return [...byStore.values()].sort(
    (a, b) => a.companyName.localeCompare(b.companyName, 'he') || a.storeName.localeCompare(b.storeName, 'he'),
  );
}

/**
 * Every voided check that needs the owner told about it, with the sentence to send. Called after a
 * bank import / auto-reconcile / bank sync, and from the nightly sweep.
 *
 * `void_alerted` records what has already been said, so the same check is not pushed every night;
 * a NEW kind of problem on the same check still gets through.
 */
export async function voidedChecksNeedingAlert(x = getExecutor()) {
  const groups = await listVoidedChecks({ scope: null }, x);
  const out = [];
  for (const g of groups) {
    for (const r of g.rows) {
      if (!r.status.alarm && r.status.key !== 'expired') continue;
      if (r.status.key === 'expired') continue; // expiry is good news; nothing to say
      out.push(r);
    }
  }
  return out;
}

/**
 * Push (and record in-app) anything new about the voided checks. Idempotent per check+problem:
 * `payments.void_alerted` holds the last status key sent, so a nightly run is quiet until
 * something actually changes.
 */
export async function alertOnVoidedChecks(x = getExecutor()) {
  const rows = await voidedChecksNeedingAlert(x);
  let sent = 0;
  for (const r of rows) {
    const already = await x.one('SELECT void_alerted FROM payments WHERE id = ?', [r.id]);
    if (already && already.void_alerted === r.status.key) continue;
    const where = `${r.store_name} · ${r.account_name}`;
    const money = `${(Math.abs(r.amount) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ₪`;
    let text;
    if (r.status.key === 'cashed') {
      text = `🔴 צ׳ק שבוטל נפרע!\nצ׳ק ${r.check_number || '—'} · ${money} · ${where}\nעבור: ${r.for_text}\nסיבת הביטול: ${voidReasonLabel(r.void_reason)}`;
    } else if (r.status.key === 'unmatched') {
      text = `⚠️ צ׳ק שבוטל כ"נפרע במזומן עבור שכר" ללא התאמה להוצאת מזומן\nצ׳ק ${r.check_number || '—'} · ${money} · ${where}\nעבור: ${r.for_text}`;
    } else {
      text = `⚠️ צ׳ק מבוטל ללא הקישור הנדרש (${voidReasonLabel(r.void_reason)})\nצ׳ק ${r.check_number || '—'} · ${money} · ${where}`;
    }
    notify(text, { kind: 'voided_check', link: `/payments/${r.id}` });
    await x.run('UPDATE payments SET void_alerted = ? WHERE id = ?', [r.status.key, r.id]);
    sent += 1;
  }
  return sent;
}

/**
 * "לא נאסף" checks that reached the six-month mark — the moment the owner asked to be told about.
 * Separate from alertOnVoidedChecks because this one fires on a DATE, not on a state change, and
 * it is good news (the check can no longer be presented) rather than a problem.
 */
export async function alertOnExpiredNotCollected(x = getExecutor()) {
  const today = israelToday();
  const rows = await x.many(
    `SELECT p.id, p.check_number, p.payment_date, p.amount, p.void_alerted,
            ba.display_name AS account_name, st.name AS store_name
       FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
       JOIN stores st ON st.id = ba.store_id
      WHERE p.status = 'voided' AND p.void_reason = 'not_collected'`,
    [],
  );
  let sent = 0;
  for (const r of rows) {
    if (r.void_alerted === 'expired') continue;
    if (today < addDaysIso(r.payment_date, CHECK_LIFE_DAYS)) continue;
    const money = `${(Math.abs(r.amount) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} ₪`;
    notify(
      `✅ חלפו 6 חודשים — צ׳ק שבוטל כ"לא נאסף" כבר לא ניתן לפירעון\nצ׳ק ${r.check_number || '—'} · ${money} · ${r.store_name} · ${r.account_name}`,
      { kind: 'voided_check', link: `/payments/${r.id}` },
    );
    await x.run("UPDATE payments SET void_alerted = 'expired' WHERE id = ?", [r.id]);
    sent += 1;
  }
  return sent;
}

/** The red dashboard banner: voided checks a bank movement matched anyway. */
export async function cashedVoidedChecks({ scope = null } = {}, x = getExecutor()) {
  const groups = await listVoidedChecks({ scope }, x);
  return groups.flatMap((g) => g.rows).filter((r) => r.status.key === 'cashed');
}

/**
 * What a void can be LINKED to, for the two reasons that demand a link.
 *
 * Both lists are derived from the check itself rather than typed, so the link cannot point at an
 * unrelated row (and, since every candidate comes from this check's own invoices/supplier, it
 * cannot cross a company either — the route still re-checks, but there is nothing to forge here).
 *
 *   • שינוי אמצעי תשלום → the LIVE payments that cover the same invoices, or any other live
 *     payment to the same supplier. That is what "re-issued by another means" looks like.
 *   • ביטול שורה בתוכנה → the invoices this check paid. Those are the rows a correction cancels.
 *
 * @returns {Promise<{payments: Array, invoices: Array}>}
 */
export async function voidLinkOptions(paymentId, x = getExecutor()) {
  const pay = await x.one('SELECT * FROM payments WHERE id = ?', [paymentId]);
  if (!pay) return { payments: [], invoices: [] };

  const invoices = await x.many(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.total_amount, i.doc_type, s.name AS supplier_name
       FROM payment_lines pl
       JOIN invoices i ON i.id = pl.invoice_id
       JOIN suppliers s ON s.id = i.supplier_id
      WHERE pl.payment_id = ?
      ORDER BY i.invoice_date DESC`,
    [paymentId],
  );

  // Live payments that cover any of the same invoices — the replacement, whatever its method.
  const invIds = invoices.map((i) => Number(i.id));
  let siblings = [];
  if (invIds.length) {
    siblings = await x.many(
      `SELECT DISTINCT p.id, p.method, p.check_number, p.reference, p.batch_number,
              p.payment_date, p.amount, p.status
         FROM payment_lines pl
         JOIN payments p ON p.id = pl.payment_id
        WHERE pl.invoice_id IN (${invIds.map(() => '?').join(',')})
          AND p.id <> ? AND p.status <> 'voided'
        ORDER BY p.payment_date DESC`,
      [...invIds, paymentId],
    );
  }
  // …plus other live payments to the same supplier (an advance re-issued, which has no lines yet).
  if (pay.supplier_id) {
    const bySupplier = await x.many(
      `SELECT p.id, p.method, p.check_number, p.reference, p.batch_number, p.payment_date, p.amount, p.status
         FROM payments p
        WHERE p.supplier_id = ? AND p.id <> ? AND p.status <> 'voided'
        ORDER BY p.payment_date DESC`,
      [pay.supplier_id, paymentId],
    );
    const seen = new Set(siblings.map((r) => Number(r.id)));
    for (const r of bySupplier) if (!seen.has(Number(r.id))) siblings.push(r);
  }
  return { payments: siblings.slice(0, 40), invoices };
}

/**
 * Attach the link a void still owes, AFTER the fact.
 *
 * This is the normal order, not an afterthought: you cannot record the replacement payment while
 * the invoice is still paid by the check, so "שינוי אמצעי תשלום" is really void → re-issue → link.
 * The at-void picker can only offer a replacement that already exists; this is where the rest are
 * closed, from the צ'קים מבוטלים page, and it is what turns "ללא קישור" into a tracked row.
 *
 * Re-links are allowed (a wrong pick is a mis-click, not a fact), and `void_alerted` is cleared so
 * the row is re-evaluated on the next sweep rather than staying silent on a stale verdict.
 */
export async function setVoidLink(paymentId, { linkPaymentId = null, linkInvoiceId = null }, actor, x = getExecutor()) {
  const pay = await x.one("SELECT id, status FROM payments WHERE id = ?", [paymentId]);
  if (!pay) throw new NotFoundError(`תשלום ${paymentId} לא נמצא`);
  if (pay.status !== 'voided') throw new RuleError('R', 'הקישור נשמר רק לצ׳ק מבוטל');
  if (!linkPaymentId && !linkInvoiceId) throw new RuleError('VALIDATION', 'יש לבחור תשלום או חשבונית לקישור');
  await x.run(
    `UPDATE payments
        SET void_link_payment_id = COALESCE(?, void_link_payment_id),
            void_link_invoice_id = COALESCE(?, void_link_invoice_id),
            void_alerted = NULL
      WHERE id = ?`,
    [linkPaymentId ? Number(linkPaymentId) : null, linkInvoiceId ? Number(linkInvoiceId) : null, paymentId],
  );
  const { logAction } = await import('./audit.js');
  await logAction(
    { userId: actor?.id ?? null, action: 'payment.void_link', entityType: 'payment', entityId: paymentId, details: { linkPaymentId, linkInvoiceId } },
    x,
  );
  return x.one('SELECT * FROM payments WHERE id = ?', [paymentId]);
}

/**
 * Is the database new enough for this feature?
 *
 * The owner upgrades the live Postgres by hand (הגדרות ← "עדכן מסד נתונים"), so between a deploy
 * and that click the columns simply are not there — and the page answered with a raw
 * "column p.voided_by does not exist" error screen. The same tolerance already guards the
 * supplier/employee store links (lib/scope.js#filterByStoreLinks): probe, and degrade to a sentence
 * that says what to do instead of an error.
 */
export async function voidedChecksReady(x = getExecutor()) {
  try {
    await x.many('SELECT void_reason FROM payments LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

/** Same probe for the wage rubric — its table arrives in the same upgrade. */
export async function salaryPaymentsReady(x = getExecutor()) {
  try {
    await x.many('SELECT id FROM salary_payments LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}
