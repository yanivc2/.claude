import { getExecutor, nowTs } from '../db/adapter.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { toAgorot, formatIls } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { logAction } from './audit.js';

// Bank transfers (העברות בנקאיות) — ROADMAP §D. A transfer moves money out of an account
// WITHOUT a physical check. The control workflow mirrors the checks flow:
//   secretary schedules  →  attaches an אסמכתא (reference)  →  owner approves the proof (R6)
//   →  it is executed  →  reconciled to an invoice (or explicitly flagged as having none).
// A transfer that is not matched to an invoice pushes a Telegram alert to the owner.

const SELECT_JOINED = `
  SELECT tr.*, ba.display_name AS account_name, c.name AS company_name, st.name AS store_name,
         inv.invoice_number AS invoice_number
    FROM bank_transfers tr
    JOIN bank_accounts ba ON ba.id = tr.bank_account_id
    JOIN companies c ON c.id = ba.company_id
    JOIN stores st ON st.id = ba.store_id
    LEFT JOIN invoices inv ON inv.id = tr.invoice_id`;

/** List transfers, newest first, optionally filtered by status and/or bank account. */
export async function listTransfers({ status = null, accountId = null } = {}, x = getExecutor()) {
  const where = [];
  const params = [];
  if (status) { where.push('tr.status = ?'); params.push(status); }
  if (accountId) { where.push('tr.bank_account_id = ?'); params.push(accountId); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  return x.many(`${SELECT_JOINED}${clause} ORDER BY tr.transfer_date DESC, tr.id DESC`, params);
}

export async function getTransfer(id, x = getExecutor()) {
  const row = await x.one(`${SELECT_JOINED} WHERE tr.id = ?`, [id]);
  if (!row) throw new NotFoundError(`העברה ${id} לא נמצאה`);
  return row;
}

/**
 * Schedule a new transfer. Amount is entered in shekels and stored as agorot. A transfer that
 * is not matched to an invoice (match_type != 'invoice') fires an owner alert (ROADMAP §D:
 * "פוש על העברה ללא התאמה").
 */
export async function createTransfer(
  {
    bankAccountId,
    payee,
    amount,
    transferDate,
    reference = null,
    recurrence = 'once',
    invoiceId = null,
    matchType = 'pending',
    matchNote = null,
    notes = null,
  },
  actor,
  x = getExecutor(),
) {
  const payeeTrim = (payee ?? '').trim();
  if (!payeeTrim) throw new RuleError('VALIDATION', 'שם מקבל ההעברה חובה');
  if (!bankAccountId) throw new RuleError('VALIDATION', 'יש לבחור חשבון בנק');
  if (!transferDate) throw new RuleError('VALIDATION', 'תאריך העברה חובה');
  const amountAgorot = toAgorot(amount);
  if (amountAgorot <= 0) throw new RuleError('VALIDATION', 'סכום ההעברה חייב להיות חיובי');
  if (!['once', 'monthly'].includes(recurrence)) recurrence = 'once';

  // Resolve the match: an explicit invoice wins; otherwise honor the chosen flag.
  let resolvedMatch = 'pending';
  let resolvedInvoice = null;
  if (invoiceId) {
    resolvedInvoice = Number(invoiceId);
    resolvedMatch = 'invoice';
  } else if (matchType === 'none') {
    resolvedMatch = 'none';
  }

  const info = await x.run(
    `INSERT INTO bank_transfers
       (bank_account_id, payee, amount, transfer_date, reference, recurrence, status,
        proof_approved, invoice_id, match_type, match_note, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?, ?, ?, ?)`,
    [
      Number(bankAccountId),
      payeeTrim,
      amountAgorot,
      transferDate,
      reference?.trim() || null,
      recurrence,
      resolvedInvoice,
      resolvedMatch,
      matchNote?.trim() || null,
      notes?.trim() || null,
      actor.id,
    ],
  );

  await logAction(
    {
      userId: actor.id,
      action: 'transfer.create',
      entityType: 'transfer',
      entityId: info.lastInsertRowid,
      details: { payee: payeeTrim, amount: amountAgorot, matchType: resolvedMatch },
    },
    x,
  );

  // ROADMAP §D — alert the owner when a transfer has no invoice matched to it.
  if (resolvedMatch !== 'invoice') {
    notify(
      `🔔 העברה חדשה ללא התאמה לחשבונית\n${payeeTrim} · ${formatIls(amountAgorot)} · ${transferDate}` +
        (reference ? `\nאסמכתא: ${reference}` : '\n⚠ ללא אסמכתא'),
    );
  }

  return getTransfer(info.lastInsertRowid, x);
}

function requireOwner(actor, message) {
  if (!actor || actor.role !== 'owner') throw new AuthError(message);
}

/** Owner approves the transfer's proof (אסמכתא) — the gate before it may be executed (R6-style). */
export async function approveTransferProof(id, actor, x = getExecutor()) {
  requireOwner(actor, 'אישור אסמכתת העברה — בעלים בלבד');
  const tr = await getTransfer(id, x);
  if (tr.status === 'cancelled') throw new RuleError('STATE', 'העברה מבוטלת — לא ניתן לאשר.');
  if (!tr.reference) throw new RuleError('NO_PROOF', 'אין אסמכתא להעברה — יש לצרף אסמכתא לפני אישור.');
  await x.run('UPDATE bank_transfers SET proof_approved = 1 WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'transfer.approve_proof', entityType: 'transfer', entityId: id }, x);
  return getTransfer(id, x);
}

/**
 * Mark a transfer executed. Blocked until the owner has approved its proof — the control that
 * keeps money from leaving on an unverified/unapproved transfer.
 */
export async function executeTransfer(id, actor, x = getExecutor()) {
  const tr = await getTransfer(id, x);
  if (tr.status === 'executed') return tr;
  if (tr.status === 'cancelled') throw new RuleError('STATE', 'העברה מבוטלת — לא ניתן לבצע.');
  if (!tr.proof_approved) throw new RuleError('NOT_APPROVED', 'ההעברה טרם אושרה על ידי הבעלים — לא ניתן לבצע.');
  await x.run("UPDATE bank_transfers SET status = 'executed', executed_at = ? WHERE id = ?", [nowTs(), id]);
  await logAction({ userId: actor.id, action: 'transfer.execute', entityType: 'transfer', entityId: id }, x);
  return getTransfer(id, x);
}

/** Cancel a transfer (reversible state on the money — owner only, with a reason). */
export async function cancelTransfer(id, actor, reason = null, x = getExecutor()) {
  requireOwner(actor, 'ביטול העברה — בעלים בלבד');
  await getTransfer(id, x);
  await x.run("UPDATE bank_transfers SET status = 'cancelled', cancel_reason = ? WHERE id = ?", [
    reason?.trim() || null,
    id,
  ]);
  await logAction(
    { userId: actor.id, action: 'transfer.cancel', entityType: 'transfer', entityId: id, details: { reason } },
    x,
  );
  return getTransfer(id, x);
}

/** Attach/replace the אסמכתא reference on a transfer (resets owner approval). */
export async function setTransferReference(id, reference, actor, x = getExecutor()) {
  const tr = await getTransfer(id, x);
  if (tr.status === 'cancelled') throw new RuleError('STATE', 'העברה מבוטלת.');
  await x.run('UPDATE bank_transfers SET reference = ?, proof_approved = 0 WHERE id = ?', [
    reference?.trim() || null,
    id,
  ]);
  await logAction({ userId: actor.id, action: 'transfer.set_reference', entityType: 'transfer', entityId: id }, x);
  return getTransfer(id, x);
}

/** Dashboard widget figures: scheduled transfers and how many still await owner approval. */
export async function transfersSummary(x = getExecutor()) {
  const scheduled = await x.one(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM bank_transfers WHERE status = 'scheduled'",
    [],
  );
  const awaiting = await x.one(
    "SELECT COUNT(*) AS n FROM bank_transfers WHERE status = 'scheduled' AND proof_approved = 0",
    [],
  );
  const unmatched = await x.one(
    "SELECT COUNT(*) AS n FROM bank_transfers WHERE status != 'cancelled' AND match_type != 'invoice'",
    [],
  );
  return {
    scheduledCount: scheduled.n,
    scheduledTotal: scheduled.total,
    awaitingApproval: awaiting.n,
    unmatched: unmatched.n,
  };
}

/** Open (approved-for-payment or recorded) invoices for the "match to invoice" picker. */
export async function openInvoicesForMatch(x = getExecutor()) {
  return x.many(
    `SELECT i.id, i.invoice_number, i.total_amount, s.name AS supplier_name, st.name AS store_name
       FROM invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       JOIN stores st ON st.id = i.store_id
      WHERE i.status IN ('recorded','approved_for_payment')
      ORDER BY i.invoice_date DESC, i.id DESC
      LIMIT 200`,
    [],
  );
}
