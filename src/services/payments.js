import { getDb } from '../db/index.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

/**
 * Issue a payment (physical check) against a set of invoices/credit notes.
 *
 * Enforces the core payment controls:
 *   Check-blocking — a payment requires a check_number AND at least one linked invoice.
 *   R1 — every linked invoice must be `approved_for_payment` AND its supplier `approved`.
 *   R5 — the check amount must equal the sum of applied lines (invoices minus credits).
 *
 * In stage 1 each selected invoice is applied in full (amount_applied = total_amount);
 * partial payments are out of scope. All selected invoices must belong to the same bank
 * account as the check (a check is drawn on one store's account, §2 1:1 mapping).
 *
 * @returns {object} the created payment with its lines
 */
export function createPayment(input, actor, db = getDb()) {
  const { bankAccountId, checkNumber, paymentDate, invoiceIds = [] } = input;

  // ---- check-blocking rule ----------------------------------------------------
  if (!checkNumber || !String(checkNumber).trim()) {
    throw new RuleError('CHECK', 'לא ניתן להנפיק תשלום ללא מספר צ׳ק');
  }
  if (!paymentDate) throw new RuleError('VALIDATION', 'תאריך תשלום חובה');
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new RuleError('CHECK', 'לא ניתן להנפיק צ׳ק ללא חשבונית מקושרת');
  }

  const account = db.prepare('SELECT * FROM bank_accounts WHERE id = ?').get(bankAccountId);
  if (!account) throw new NotFoundError(`חשבון בנק ${bankAccountId} לא נמצא`);

  const result = db.transaction(() => {
    let net = 0;
    const lines = [];

    for (const invId of invoiceIds) {
      const inv = db
        .prepare(
          `SELECT i.*, s.status AS supplier_status, s.name AS supplier_name,
                  ba.id AS store_bank_account_id
             FROM invoices i
             JOIN suppliers s ON s.id = i.supplier_id
             JOIN bank_accounts ba ON ba.store_id = i.store_id
            WHERE i.id = ?`,
        )
        .get(invId);
      if (!inv) throw new NotFoundError(`חשבונית ${invId} לא נמצאה`);

      // R1: invoice must be approved for payment AND supplier approved.
      if (inv.status !== 'approved_for_payment') {
        throw new RuleError(
          'R1',
          `חשבונית #${inv.id} בסטטוס "${inv.status}" — נדרש approved_for_payment לתשלום`,
          { invoiceId: inv.id },
        );
      }
      if (inv.supplier_status !== 'approved') {
        throw new RuleError(
          'R1',
          `הספק "${inv.supplier_name}" אינו מאושר (status=${inv.supplier_status}) — תשלום חסום`,
          { invoiceId: inv.id },
        );
      }

      // All invoices on one check must be drawn on the same account as the check.
      if (inv.store_bank_account_id !== account.id) {
        throw new RuleError(
          'ACCOUNT',
          `חשבונית #${inv.id} משויכת לחשבון בנק אחר — כל החשבוניות בצ׳ק חייבות להיות מאותו חשבון`,
          { invoiceId: inv.id },
        );
      }

      net += inv.total_amount; // credit notes are negative
      lines.push({ invoiceId: inv.id, amountApplied: inv.total_amount });
    }

    if (net <= 0) {
      throw new RuleError(
        'R5',
        `נטו לתשלום הוא ${net / 100} ₪ — לא ניתן להנפיק צ׳ק בסכום אפס או שלילי`,
      );
    }

    const info = db
      .prepare(
        `INSERT INTO payments (bank_account_id, check_number, payment_date, amount, status, created_by)
         VALUES (?, ?, ?, ?, 'issued', ?)`,
      )
      .run(account.id, String(checkNumber).trim(), paymentDate, net, actor.id);
    const paymentId = info.lastInsertRowid;

    const insertLine = db.prepare(
      'INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, ?)',
    );
    for (const line of lines) {
      insertLine.run(paymentId, line.invoiceId, line.amountApplied);
      db.prepare("UPDATE invoices SET status = 'paid', bank_account_id = ? WHERE id = ?").run(
        account.id,
        line.invoiceId,
      );
    }

    // R5 integrity assertion: sum of lines must equal the check amount.
    const sum = db
      .prepare('SELECT COALESCE(SUM(amount_applied),0) AS s FROM payment_lines WHERE payment_id = ?')
      .get(paymentId).s;
    if (sum !== net) {
      throw new RuleError('R5', `אי-התאמה בין סכום הצ׳ק (${net}) לסכום השורות (${sum})`);
    }

    logAction(
      {
        userId: actor.id,
        action: 'payment.create',
        entityType: 'payment',
        entityId: paymentId,
        details: { checkNumber: String(checkNumber).trim(), amount: net, invoiceIds },
      },
      db,
    );

    return getPaymentDetail(paymentId, db);
  })();

  return result;
}

/** Manually mark a check as cleared (stage-1 manual reconciliation; R7 automates this in stage 2). */
export function markCleared(id, clearedDate, actor, db = getDb()) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  if (payment.status === 'voided') throw new RuleError('R', 'צ׳ק מבוטל — לא ניתן לסמן כנפרע');

  db.prepare("UPDATE payments SET status = 'cleared', cleared_date = ? WHERE id = ?").run(
    clearedDate || new Date().toISOString().slice(0, 10),
    id,
  );
  logAction({ userId: actor.id, action: 'payment.clear', entityType: 'payment', entityId: id, details: { clearedDate } }, db);
  return getPaymentDetail(id, db);
}

/** Void a check (e.g. spoiled/cancelled). Reverts its invoices back to approved_for_payment. */
export function voidPayment(id, actor, reason = null, db = getDb()) {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);

  db.transaction(() => {
    const lines = db.prepare('SELECT invoice_id FROM payment_lines WHERE payment_id = ?').all(id);
    for (const line of lines) {
      db.prepare(
        "UPDATE invoices SET status = 'approved_for_payment', bank_account_id = NULL WHERE id = ?",
      ).run(line.invoice_id);
    }
    db.prepare("UPDATE payments SET status = 'voided' WHERE id = ?").run(id);
    logAction({ userId: actor.id, action: 'payment.void', entityType: 'payment', entityId: id, details: { reason } }, db);
  })();

  return getPaymentDetail(id, db);
}

export function getPaymentDetail(id, db = getDb()) {
  const payment = db
    .prepare(
      `SELECT p.*, ba.display_name AS bank_account_name
         FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id
        WHERE p.id = ?`,
    )
    .get(id);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  payment.lines = db
    .prepare(
      `SELECT pl.*, i.invoice_number, i.doc_type, i.invoice_date, s.name AS supplier_name
         FROM payment_lines pl
         JOIN invoices i ON i.id = pl.invoice_id
         JOIN suppliers s ON s.id = i.supplier_id
        WHERE pl.payment_id = ?`,
    )
    .all(id);
  return payment;
}

export function listPayments({ status = null } = {}, db = getDb()) {
  const base = `SELECT p.*, ba.display_name AS bank_account_name
                  FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id`;
  if (status) return db.prepare(`${base} WHERE p.status = ? ORDER BY p.id DESC`).all(status);
  return db.prepare(`${base} ORDER BY p.id DESC`).all();
}
