import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { NotFoundError, RuleError, AuthError } from '../lib/errors.js';
import { amountToHebrewWords } from '../lib/hebrewAmount.js';
import { logAction } from './audit.js';

const METHODS = ['check', 'cash', 'credit', 'transfer', 'batch'];

/**
 * Issue a payment against a set of invoices/credit notes. Supports several methods:
 * check, cash, credit, transfer, batch — each with its own identifier fields.
 *
 * Enforces the core payment controls for EVERY method:
 *   No payment without at least one linked (approved) invoice + the method's identifier.
 *   R1 — every linked invoice must be `approved_for_payment` AND its supplier `approved`.
 *   R5 — the amount must equal the sum of applied lines (invoices minus credits).
 *
 * Each selected invoice is applied in full (amount_applied = total_amount). All selected
 * invoices must belong to the same bank account as the payment (§2 1:1 mapping).
 *
 * @returns {object} the created payment with its lines
 */
export function createPayment(input, actor, db = getDb()) {
  const {
    bankAccountId,
    method = 'check',
    checkNumber,
    reference,
    payerName,
    cardLast4,
    batchNumber,
    paymentDate,
    invoiceIds = [],
  } = input;

  if (!METHODS.includes(method)) throw new RuleError('VALIDATION', `אמצעי תשלום לא תקין: ${method}`);
  if (!paymentDate) throw new RuleError('VALIDATION', 'תאריך תשלום חובה');
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    throw new RuleError('CHECK', 'לא ניתן להנפיק תשלום ללא חשבונית מקושרת');
  }

  // ---- per-method identifier (the "no payment without an identifier" control) --
  const fields = { check_number: null, reference: null, payer_name: null, card_last4: null, batch_number: null };
  if (method === 'check') {
    if (!checkNumber || !String(checkNumber).trim()) throw new RuleError('CHECK', 'לא ניתן להנפיק צ׳ק ללא מספר צ׳ק');
    fields.check_number = String(checkNumber).trim();
  } else if (method === 'cash') {
    if (!payerName || !String(payerName).trim()) throw new RuleError('VALIDATION', 'תשלום מזומן — שם המשלם חובה');
    fields.payer_name = String(payerName).trim();
  } else if (method === 'credit') {
    const last4 = String(cardLast4 || '').trim();
    if (!/^\d{4}$/.test(last4)) throw new RuleError('VALIDATION', 'תשלום אשראי — 4 ספרות אחרונות חובה');
    fields.card_last4 = last4;
  } else if (method === 'transfer') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'העברה — מספר אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'batch') {
    if (!batchNumber || !String(batchNumber).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר מקבץ חובה');
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר אסמכתא חובה');
    fields.batch_number = String(batchNumber).trim();
    fields.reference = String(reference).trim();
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
        `נטו לתשלום הוא ${net / 100} ₪ — לא ניתן להנפיק תשלום בסכום אפס או שלילי`,
      );
    }

    const info = db
      .prepare(
        `INSERT INTO payments
           (bank_account_id, method, check_number, reference, payer_name, card_last4, batch_number,
            payment_date, amount, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
      )
      .run(
        account.id,
        method,
        fields.check_number,
        fields.reference,
        fields.payer_name,
        fields.card_last4,
        fields.batch_number,
        paymentDate,
        net,
        actor.id,
      );
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
        details: { method, ...fields, amount: net, invoiceIds },
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

/** Void a check (e.g. spoiled/cancelled). Reverts its invoices back to approved_for_payment.
 *  Owner-only — voiding an issued check is a significant, reversible-only-by-reissue action. */
export function voidPayment(id, actor, reason = null, db = getDb()) {
  if (!actor || actor.role !== 'owner') throw new AuthError('ביטול צ׳ק — בעלים בלבד');
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

/**
 * Assemble everything needed to render a Standard-501 check for a payment (stage 4).
 * The payee is derived from the linked invoices' supplier(s); the drawer is the account's
 * company. `approved` reflects the gating flag — when false the check is a watermarked DRAFT
 * and the MICR line is a placeholder, never a scanner-valid magnetic encoding (🔴 §11.5).
 */
export function getCheckPrintData(id, db = getDb()) {
  const payment = getPaymentDetail(id, db);
  if (payment.method !== 'check') {
    throw new RuleError('PRINT', 'הדפסת צ׳ק זמינה רק לתשלום מסוג צ׳ק');
  }
  const account = db
    .prepare(
      `SELECT ba.*, c.name AS company_name, c.tax_id AS company_tax_id
         FROM bank_accounts ba JOIN companies c ON c.id = ba.company_id
        WHERE ba.id = ?`,
    )
    .get(payment.bank_account_id);

  const payees = db
    .prepare(
      `SELECT DISTINCT s.name FROM payment_lines pl
         JOIN invoices i ON i.id = pl.invoice_id
         JOIN suppliers s ON s.id = i.supplier_id
        WHERE pl.payment_id = ?`,
    )
    .all(id)
    .map((r) => r.name);

  return {
    payment,
    account,
    payees,
    amountWords: amountToHebrewWords(payment.amount),
    approved: config.checkPrinting.approved,
  };
}

export function listPayments({ status = null, companyId = null, storeId = null } = {}, db = getDb()) {
  const where = [];
  const params = [];
  if (status) {
    where.push('p.status = ?');
    params.push(status);
  }
  if (companyId) {
    where.push('ba.company_id = ?');
    params.push(companyId);
  }
  if (storeId) {
    where.push('ba.store_id = ?');
    params.push(storeId);
  }
  const sql = `SELECT p.*, ba.display_name AS bank_account_name,
                      c.name AS company_name, st.name AS store_name
                 FROM payments p
                 JOIN bank_accounts ba ON ba.id = p.bank_account_id
                 JOIN companies c ON c.id = ba.company_id
                 JOIN stores st ON st.id = ba.store_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY p.id DESC`;
  return db.prepare(sql).all(...params);
}

/** Lookup payments by (last digits of) check number / transfer reference / batch number. */
export function lookupChecks(query, db = getDb()) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;
  return db
    .prepare(
      `SELECT p.id, p.method, p.check_number, p.reference, p.batch_number,
              p.payment_date, p.amount, p.status,
              ba.display_name AS bank_account_name, s.name AS supplier_name
         FROM payments p
         JOIN bank_accounts ba ON ba.id = p.bank_account_id
         LEFT JOIN payment_lines pl ON pl.payment_id = p.id
         LEFT JOIN invoices i ON i.id = pl.invoice_id
         LEFT JOIN suppliers s ON s.id = i.supplier_id
        WHERE p.check_number LIKE ? OR p.reference LIKE ? OR p.batch_number LIKE ?
        GROUP BY p.id
        ORDER BY p.id DESC`,
    )
    .all(like, like, like);
}
