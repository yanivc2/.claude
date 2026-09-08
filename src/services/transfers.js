// "העברות בנקאיות" — a transfer is REQUESTED in the app before anyone touches the bank.
//
// THE PROBLEM: the secretary logs into the bank, makes a batch transfer, sends a photo on WhatsApp,
// and the owner approves by comparing the photo to the movement. The approval happens after the
// money has gone, and it happens outside the system.
//
// WHERE THE REAL CONTROL ALREADY IS. The bank itself enforces dual authorisation: the secretary
// signs in with her own credentials and builds the batch, and NOTHING MOVES until the owner
// approves it in the bank. So she cannot pay anyone on her own, and this page is not trying to
// re-invent that lock — it would be a worse copy of a control that already works.
//
// What is missing is everything AROUND that approval. Today it is made in the bank's screen with a
// WhatsApp photo as the only context: which invoice is this, was it already paid, is this even the
// supplier's account. That is the gap this page fills — it is the BRIEFING for an approval that
// happens elsewhere, plus the record that the approval was made:
//
//   1. The request is ticked, not typed: the invoices are chosen and the amount, supplier, store
//      and account are derived from them, so a request can never be for money nobody is owed.
//   2. The owner approves HERE, against the invoice and the supplier's known destination account —
//      that is what replaces the photo — and then approves in the bank knowing what he is looking
//      at. **The destination is the point**: a real invoice paid into a changed account is how a
//      business this size actually loses money (services/suppliers.js#setSupplierBank).
//   3. Every outgoing movement the bank reports with no request behind it is still an alarm. Not
//      because she could have paid alone — she could not — but because an approval given in the
//      bank without a request here means the briefing was skipped, and that is exactly the state
//      this page exists to prevent.
//   4. `opened_at` vs the bank's date catches BACK-FILLING: a request raised after the movement
//      already appeared is recorded and shown as such.
//
// The status is never chosen by a human: pending → approved (the owner's one action) → executed
// (the אסמכתה was recorded, which creates the real payment) → נפרע comes from the bank matching
// that payment through the existing R7 reconciliation. Nobody can mark their own transfer paid.
import { getExecutor, tx } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeWhere } from '../lib/scope.js';
import { israelToday } from '../lib/loginHours.js';
import { israelNow } from './zclosing.js';
import { notify } from '../lib/notify.js';
import { getSetting, setSetting } from './appSettings.js';
import { logAction } from './audit.js';

/** From which date an unrecorded transfer is an alarm. Set when the owner turns the watch on. */
export const WATCH_FROM_KEY = 'transfer_watch_from';

export const TRANSFER_STATUS = {
  pending: { label: 'ממתין לאישור', badge: 'b-on_hold' },
  approved: { label: 'אושר — אפשר לאשר בבנק', badge: 'b-approved' },
  executed: { label: 'אושר בבנק — ממתין לפירעון', badge: 'b-neutral' },
  cleared: { label: 'נפרע', badge: 'b-cleared' },
  rejected: { label: 'נדחה', badge: 'b-blocked' },
  cancelled: { label: 'בוטל', badge: 'b-voided' },
};
export const statusLabel = (k) => (TRANSFER_STATUS[k] || {}).label || k;

export async function getWatchFrom(x = getExecutor()) {
  return getSetting(WATCH_FROM_KEY, null, x);
}
/**
 * Turn the watch on from a date. Deliberately a date and not a boolean: the owner said the rule is
 * forward-looking only — every transfer made before the procedure existed would otherwise alarm,
 * and an alarm that fires on history is an alarm nobody reads.
 */
export async function setWatchFrom(date, actor, x = getExecutor()) {
  const iso = String(date || '').trim();
  if (iso && !/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new RuleError('VALIDATION', 'תאריך לא תקין');
  await setSetting(WATCH_FROM_KEY, iso || null, x);
  await logAction({ userId: actor?.id ?? null, action: 'transfer.watch_from', entityType: 'setting', entityId: null, details: { date: iso } }, x);
  return iso || null;
}

/** Is the schema new enough? (The owner upgrades the live DB by hand — see voidedChecks.js.) */
export async function transfersReady(x = getExecutor()) {
  try {
    await x.many('SELECT id FROM bank_transfers LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

// ── the request ────────────────────────────────────────────────────────────────────────────────

/**
 * The invoices a transfer may be raised against: unpaid, approved for payment, from an approved
 * supplier, inside the caller's scope. This IS the "only against an unpaid invoice" rule — the
 * form offers nothing else, and `createTransfer` re-checks every id it is given.
 */
export async function transferableInvoices({ storeId = null, scope = null } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'i.company_id', 'i.store_id');
  const params = [...sc.params];
  let filter = '';
  if (storeId) { filter = ' AND i.store_id = ?'; params.push(Number(storeId)); }
  return x.many(
    `SELECT i.id, i.invoice_number, i.invoice_date, i.total_amount, i.store_id, i.supplier_id,
            s.name AS supplier_name, st.name AS store_name
       FROM invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       JOIN stores st ON st.id = i.store_id
      WHERE i.status = 'approved_for_payment' AND i.doc_type <> 'credit_note'
        AND s.status = 'approved'${sc.sql}${filter}
      ORDER BY i.invoice_date, i.id`,
    params,
  );
}

/**
 * Raise a transfer request. NOTHING about the money is typed: the amount is the sum of the chosen
 * invoices, and the supplier/store/account come from them. A mix of suppliers or of stores is
 * refused — one transfer, one payee, one branch, or the owner cannot approve it meaningfully.
 */
export async function createTransfer({ invoiceIds = [], note = null }, actor, x = getExecutor()) {
  const ids = [...new Set((invoiceIds || []).map(Number).filter(Boolean))];
  if (!ids.length) throw new RuleError('VALIDATION', 'יש לבחור לפחות חשבונית אחת');

  const rows = await x.many(
    `SELECT i.*, s.status AS supplier_status FROM invoices i
       JOIN suppliers s ON s.id = i.supplier_id
      WHERE i.id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
  if (rows.length !== ids.length) throw new NotFoundError('חשבונית לא נמצאה');
  for (const inv of rows) {
    if (inv.status !== 'approved_for_payment') {
      throw new RuleError('R1', `חשבונית ${inv.invoice_number}: סטטוס "${inv.status}" — ניתן להעביר רק חשבונית מאושרת לתשלום שטרם שולמה`);
    }
    if (inv.supplier_status !== 'approved') {
      throw new RuleError('R1', `חשבונית ${inv.invoice_number}: הספק אינו מאושר`);
    }
    const open = await x.one(
      `SELECT l.id AS line_id FROM bank_transfer_lines l
         JOIN bank_transfers t ON t.id = l.transfer_id
        WHERE l.invoice_id = ? AND t.status IN (?, ?, ?)`,
      [inv.id, 'pending', 'approved', 'executed'],
    );
    if (open) throw new RuleError('R', `חשבונית ${inv.invoice_number} כבר משויכת לבקשת העברה פתוחה`);
  }
  const suppliers = new Set(rows.map((r) => Number(r.supplier_id)));
  const stores = new Set(rows.map((r) => Number(r.store_id)));
  if (suppliers.size > 1) throw new RuleError('VALIDATION', 'העברה אחת = ספק אחד. הפרד לבקשות נפרדות.');
  if (stores.size > 1) throw new RuleError('VALIDATION', 'העברה אחת = חנות אחת. הפרד לבקשות נפרדות.');

  const storeId = [...stores][0];
  const account = await x.one('SELECT id FROM bank_accounts WHERE store_id = ? LIMIT 1', [storeId]);
  if (!account) throw new RuleError('VALIDATION', 'לחנות אין חשבון בנק מוגדר');
  const amount = rows.reduce((t, r) => t + Number(r.total_amount), 0);
  if (amount <= 0) throw new RuleError('VALIDATION', 'סכום ההעברה חייב להיות חיובי');

  const info = await tx(async (t) => {
    const r = await t.run(
      `INSERT INTO bank_transfers (store_id, bank_account_id, supplier_id, amount, status, opened_at, opened_by, note)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [storeId, account.id, [...suppliers][0], amount, israelNow(), actor?.id ?? null, (note || '').trim() || null],
    );
    for (const inv of rows) {
      await t.run('INSERT INTO bank_transfer_lines (transfer_id, invoice_id) VALUES (?, ?)', [r.lastInsertRowid, inv.id]);
    }
    return r;
  });

  const sup = await x.one('SELECT name FROM suppliers WHERE id = ?', [[...suppliers][0]]);
  notify(
    `🏦 בקשת העברה חדשה — ${amount / 100} ₪\n${sup?.name || ''}\nממתינה לאישורך.`,
    { kind: 'transfer', link: `/transfers#t${info.lastInsertRowid}` },
  );
  await logAction({ userId: actor?.id ?? null, action: 'transfer.create', entityType: 'bank_transfer', entityId: info.lastInsertRowid, details: { amount, invoiceIds: ids } }, x);
  return getTransfer(info.lastInsertRowid, x);
}

export async function getTransfer(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM bank_transfers WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`בקשת העברה ${id} לא נמצאה`);
  return row;
}

/** The owner's one action. Approving a specific payee and a specific sum, before the money moves. */
export async function approveTransfer(id, actor, x = getExecutor()) {
  const t = await getTransfer(id, x);
  if (t.status !== 'pending') throw new RuleError('R', `לא ניתן לאשר בקשה בסטטוס "${statusLabel(t.status)}"`);
  await x.run("UPDATE bank_transfers SET status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?", [israelNow(), actor?.id ?? null, id]);
  await logAction({ userId: actor?.id ?? null, action: 'transfer.approve', entityType: 'bank_transfer', entityId: id }, x);
  return getTransfer(id, x);
}

export async function rejectTransfer(id, reason, actor, x = getExecutor()) {
  const t = await getTransfer(id, x);
  if (t.status !== 'pending') throw new RuleError('R', `לא ניתן לדחות בקשה בסטטוס "${statusLabel(t.status)}"`);
  await x.run("UPDATE bank_transfers SET status = 'rejected', rejected_reason = ? WHERE id = ?", [(reason || '').trim() || null, id]);
  await logAction({ userId: actor?.id ?? null, action: 'transfer.reject', entityType: 'bank_transfer', entityId: id, details: { reason } }, x);
  return getTransfer(id, x);
}

export async function cancelTransfer(id, actor, x = getExecutor()) {
  const t = await getTransfer(id, x);
  if (t.status === 'executed') throw new RuleError('R', 'ההעברה כבר בוצעה — לא ניתן לבטל את הבקשה');
  await x.run("UPDATE bank_transfers SET status = 'cancelled' WHERE id = ?", [id]);
  await logAction({ userId: actor?.id ?? null, action: 'transfer.cancel', entityType: 'bank_transfer', entityId: id }, x);
  return getTransfer(id, x);
}

/**
 * "ביצעתי — הנה האסמכתה". The ONE typed field in the whole flow, and only after the owner approved.
 * Recording it creates the real payment through the ordinary createPayment, so R1/R5, the invoice
 * status and the bank reconciliation all behave exactly as they do for any other transfer — and
 * "נפרע" then arrives from the bank, never from a person.
 */
export async function executeTransfer(id, { reference, paymentDate = null }, actor, x = getExecutor()) {
  const t = await getTransfer(id, x);
  if (t.status !== 'approved') {
    throw new RuleError('R', t.status === 'pending'
      ? 'הבקשה ממתינה לאישור הבעלים — אשר כאן לפני שאתה משחרר את המקבץ בבנק'
      : `לא ניתן לבצע בקשה בסטטוס "${statusLabel(t.status)}"`);
  }
  const ref = (reference || '').toString().trim();
  if (!ref) throw new RuleError('VALIDATION', 'יש להזין את מספר האסמכתה מהבנק');

  const lines = await x.many('SELECT invoice_id FROM bank_transfer_lines WHERE transfer_id = ?', [id]);
  const { createPayment } = await import('./payments.js');
  const payment = await createPayment(
    {
      bankAccountId: t.bank_account_id,
      method: 'transfer',
      reference: ref,
      paymentDate: paymentDate || israelToday(),
      invoiceIds: lines.map((l) => Number(l.invoice_id)),
    },
    actor,
    x,
  );
  await x.run(
    "UPDATE bank_transfers SET status = 'executed', executed_at = ?, reference = ?, payment_id = ? WHERE id = ?",
    [israelNow(), ref, payment.id, id],
  );
  await logAction({ userId: actor?.id ?? null, action: 'transfer.execute', entityType: 'bank_transfer', entityId: id, details: { reference: ref, paymentId: payment.id } }, x);
  return getTransfer(id, x);
}

// ── the page ───────────────────────────────────────────────────────────────────────────────────

/**
 * Requests the caller may see, newest first, with the display status resolved.
 *
 * "נפרע" is not a stored status: it is the payment being cleared, which only the bank can cause.
 * Computing it here means nobody can ever mark their own transfer paid.
 */
export async function listTransfers({ scope = null, limit = 200 } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 't.store_id');
  const rows = await x.many(
    `SELECT t.*, st.name AS store_name, s.name AS supplier_name,
            uo.name AS opened_by_name, ua.name AS approved_by_name,
            p.status AS payment_status
       FROM bank_transfers t
       JOIN stores st ON st.id = t.store_id
       LEFT JOIN suppliers s ON s.id = t.supplier_id
       LEFT JOIN users uo ON uo.id = t.opened_by
       LEFT JOIN users ua ON ua.id = t.approved_by
       LEFT JOIN payments p ON p.id = t.payment_id
      WHERE 1 = 1${sc.sql}
      ORDER BY t.id DESC LIMIT ?`,
    [...sc.params, limit],
  );
  if (!rows.length) return [];
  const lines = await x.many(
    `SELECT l.transfer_id, i.id, i.invoice_number, i.total_amount
       FROM bank_transfer_lines l JOIN invoices i ON i.id = l.invoice_id`,
    [],
  );
  const byTransfer = new Map();
  for (const l of lines) {
    const k = Number(l.transfer_id);
    if (!byTransfer.has(k)) byTransfer.set(k, []);
    byTransfer.get(k).push(l);
  }
  // The supplier's destination account, carried onto every row — this is what the owner compares
  // against the bank screen when approving, and the recent-change warning is the alarm that
  // matters most (see services/suppliers.js#setSupplierBank).
  const { bankChangedRecently, BANK_CHANGE_WARN_DAYS } = await import('./suppliers.js');
  let banks = [];
  try {
    banks = await x.many('SELECT id, bank_name, bank_branch, bank_account, bank_holder, bank_updated_at FROM suppliers', []);
  } catch { banks = []; } // pre-upgrade database
  const bankById = new Map(banks.map((b) => [Number(b.id), b]));

  return rows.map((r) => {
    const bank = bankById.get(Number(r.supplier_id)) || null;
    return {
      ...r,
      invoices: byTransfer.get(Number(r.id)) || [],
      displayStatus: r.status === 'executed' && r.payment_status === 'cleared' ? 'cleared' : r.status,
      bank,
      bankMissing: !bank || !bank.bank_account,
      bankChangedRecently: bank ? bankChangedRecently(bank) : false,
      bankWarnDays: BANK_CHANGE_WARN_DAYS,
    };
  });
}

// ── the enforcement ────────────────────────────────────────────────────────────────────────────

/**
 * Outgoing bank movements that look like transfers and have NO request behind them.
 *
 * This is the part that actually enforces the procedure, because it reads the bank's own statement
 * rather than anything a person typed. A movement counts as untracked when it is a debit, is not
 * matched to any payment, does not carry the אסמכתה of any transfer we know about, and is dated on
 * or after the watch date.
 *
 * The watch date is not optional politeness — without it every transfer ever made would alarm, and
 * the owner was explicit that the rule is forward-looking. Checks are excluded: they are tracked by
 * their own number through the payments table and would otherwise double-report.
 */
export async function untrackedTransfers({ scope = null } = {}, x = getExecutor()) {
  const from = await getWatchFrom(x);
  if (!from) return [];
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  const txns = await x.many(
    `SELECT bt.id, bt.txn_date, bt.amount, bt.description, bt.raw_reference,
            ba.display_name AS account_name, st.name AS store_name, ba.store_id AS store_id
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       JOIN stores st ON st.id = ba.store_id
      WHERE bt.matched_payment_id IS NULL AND bt.amount < 0 AND bt.txn_date >= ?${sc.sql}
      ORDER BY bt.txn_date DESC, bt.id DESC`,
    [from, ...sc.params],
  );
  if (!txns.length) return [];

  // Anything whose identifier we already know about is tracked, whatever its state.
  const known = new Set();
  for (const r of await x.many("SELECT reference FROM bank_transfers WHERE reference IS NOT NULL", [])) {
    known.add(String(r.reference).trim());
  }
  for (const r of await x.many("SELECT reference, check_number, batch_number FROM payments WHERE status <> 'voided'", [])) {
    for (const v of [r.reference, r.check_number, r.batch_number]) if (v) known.add(String(v).trim());
  }
  const looksTracked = (t) => {
    const ref = String(t.raw_reference ?? '').trim();
    const text = `${t.description ?? ''} ${t.raw_reference ?? ''}`;
    return [...known].some((k) => k && (k === ref || text.includes(k)));
  };
  // A check is tracked through its own number and its own page — reporting it here would double up.
  const isCheck = (t) => /שיק|צ'ק|צ׳ק|check/i.test(String(t.description ?? ''));

  return txns.filter((t) => !isCheck(t) && !looksTracked(t));
}

/**
 * Push + in-app for every untracked movement, once each. `app_settings` holds the ids already
 * reported, so a nightly sweep is silent until the bank shows something new.
 */
export async function alertOnUntrackedTransfers(x = getExecutor()) {
  const rows = await untrackedTransfers({ scope: null }, x);
  if (!rows.length) return 0;
  const KEY = 'transfer_alerted_ids';
  const seen = new Set(String((await getSetting(KEY, '', x)) || '').split(',').filter(Boolean));
  let sent = 0;
  for (const t of rows) {
    if (seen.has(String(t.id))) continue;
    notify(
      `🔴 העברה בבנק ללא תיעוד\n${Math.abs(t.amount) / 100} ₪ · ${t.txn_date} · ${t.store_name} · ${t.account_name}\n${t.description || ''}\nלא נמצאה בקשת העברה מאושרת מאחוריה.`,
      { kind: 'transfer_untracked', link: '/transfers' },
    );
    seen.add(String(t.id));
    sent += 1;
  }
  if (sent) await setSetting(KEY, [...seen].join(','), x);
  return sent;
}

/**
 * Requests raised AFTER the money already moved — back-filling. Not an accusation on its own (a
 * statement can be imported late), but it is the one thing a procedure cannot police by itself, so
 * it is surfaced next to the request rather than left invisible.
 */
export function backfilled(transfer, txnDate) {
  if (!transfer?.opened_at || !txnDate) return false;
  return String(transfer.opened_at).slice(0, 10) > String(txnDate).slice(0, 10);
}

/** Today, for the "turn the watch on" default. */
export const watchDefault = () => israelToday();
