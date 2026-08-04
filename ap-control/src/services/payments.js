import { getExecutor, tx } from '../db/adapter.js';
import { config } from '../config.js';
import { NotFoundError, RuleError, AuthError } from '../lib/errors.js';
import { userCan } from '../lib/permissions.js';
import { scopeClause } from '../lib/scope.js';
import { amountToHebrewWords } from '../lib/hebrewAmount.js';
import { logAction } from './audit.js';

const METHODS = ['check', 'cash', 'credit', 'transfer', 'batch'];

/**
 * Issue a payment against a set of invoices/credit notes (check/cash/credit/transfer/batch).
 * Enforces: at least one linked approved invoice + the method's identifier; R1 (invoice
 * approved_for_payment AND supplier approved); R5 (amount == sum of applied lines).
 * @returns {object} the created payment with its lines
 */
export async function createPayment(input, actor, x = getExecutor()) {
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

  const account = await x.one('SELECT * FROM bank_accounts WHERE id = ?', [bankAccountId]);
  if (!account) throw new NotFoundError(`חשבון בנק ${bankAccountId} לא נמצא`);

  const paymentId = await tx(async (t) => {
    let net = 0;
    const lines = [];

    for (const invId of invoiceIds) {
      const inv = await t.one(
        `SELECT i.*, s.status AS supplier_status, s.name AS supplier_name,
                ba.id AS store_bank_account_id
           FROM invoices i
           JOIN suppliers s ON s.id = i.supplier_id
           JOIN bank_accounts ba ON ba.store_id = i.store_id
          WHERE i.id = ?`,
        [invId],
      );
      if (!inv) throw new NotFoundError(`חשבונית ${invId} לא נמצאה`);

      // Paying an invoice implicitly approves it: accept "recorded" and "approved_for_payment".
      // R3-blocked (on_hold) and already-paid invoices are still refused.
      if (!['recorded', 'approved_for_payment'].includes(inv.status)) {
        const why = inv.status === 'on_hold' ? 'החשבונית מוחזקת (R3) — שחרר אותה לפני תשלום' : `סטטוס "${inv.status}"`;
        throw new RuleError('R1', `חשבונית #${inv.id}: ${why}`, { invoiceId: inv.id });
      }
      if (inv.supplier_status !== 'approved') {
        throw new RuleError('R1', `הספק "${inv.supplier_name}" אינו מאושר (status=${inv.supplier_status}) — תשלום חסום`, { invoiceId: inv.id });
      }
      if (inv.store_bank_account_id !== account.id) {
        throw new RuleError('ACCOUNT', `חשבונית #${inv.id} משויכת לחשבון בנק אחר — כל החשבוניות בצ׳ק חייבות להיות מאותו חשבון`, { invoiceId: inv.id });
      }

      net += inv.total_amount; // credit notes are negative
      lines.push({ invoiceId: inv.id, amountApplied: inv.total_amount });
    }

    if (net <= 0) {
      throw new RuleError('R5', `נטו לתשלום הוא ${net / 100} ₪ — לא ניתן להנפיק תשלום בסכום אפס או שלילי`);
    }

    // Cash ceiling (חוק צמצום השימוש במזומן) — block cash over the legal limit.
    if (method === 'cash' && config.cashCeilingAgorot > 0 && net > config.cashCeilingAgorot) {
      throw new RuleError(
        'CASH_LIMIT',
        `תשלום במזומן מוגבל ל-${config.cashCeilingAgorot / 100} ₪ לפי חוק צמצום השימוש במזומן. שלם באמצעי אחר.`,
      );
    }

    const info = await t.run(
      `INSERT INTO payments
         (bank_account_id, method, check_number, reference, payer_name, card_last4, batch_number,
          payment_date, amount, status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?)`,
      [
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
      ],
    );
    const pid = info.lastInsertRowid;

    for (const line of lines) {
      await t.run('INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, ?)', [
        pid,
        line.invoiceId,
        line.amountApplied,
      ]);
      await t.run("UPDATE invoices SET status = 'paid', bank_account_id = ? WHERE id = ?", [account.id, line.invoiceId]);
    }

    const sumRow = await t.one('SELECT COALESCE(SUM(amount_applied),0) AS s FROM payment_lines WHERE payment_id = ?', [pid]);
    if (sumRow.s !== net) {
      throw new RuleError('R5', `אי-התאמה בין סכום הצ׳ק (${net}) לסכום השורות (${sumRow.s})`);
    }

    await logAction(
      { userId: actor.id, action: 'payment.create', entityType: 'payment', entityId: pid, details: { method, ...fields, amount: net, invoiceIds } },
      t,
    );
    return pid;
  });

  return getPaymentDetail(paymentId, x);
}

/** Manually mark a check as cleared (stage-1 manual reconciliation; R7 automates this in stage 2). */
export async function markCleared(id, clearedDate, actor, x = getExecutor()) {
  const payment = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  if (payment.status === 'voided') throw new RuleError('R', 'צ׳ק מבוטל — לא ניתן לסמן כנפרע');

  await x.run("UPDATE payments SET status = 'cleared', cleared_date = ? WHERE id = ?", [
    clearedDate || new Date().toISOString().slice(0, 10),
    id,
  ]);
  await logAction({ userId: actor.id, action: 'payment.clear', entityType: 'payment', entityId: id, details: { clearedDate } }, x);
  return getPaymentDetail(id, x);
}

/** Revert a manually-cleared check back to 'issued' (undo an accidental "mark cleared"). */
export async function markIssued(id, actor, x = getExecutor()) {
  const payment = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  if (payment.status === 'voided') throw new RuleError('R', 'צ׳ק מבוטל — לא ניתן לשנות סטטוס');
  if (payment.status === 'issued') return getPaymentDetail(id, x);
  await x.run("UPDATE payments SET status = 'issued', cleared_date = NULL WHERE id = ?", [id]);
  await logAction({ userId: actor.id, action: 'payment.unclear', entityType: 'payment', entityId: id }, x);
  return getPaymentDetail(id, x);
}

/** Void a check. Reverts its invoices back to approved_for_payment. Owner-only. */
export async function voidPayment(id, actor, reason = null, x = getExecutor()) {
  if (!userCan(actor, 'void_payment')) throw new AuthError('ביטול צ׳ק — נדרשת הרשאת ביטול תשלום');
  const payment = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);

  await tx(async (t) => {
    const lines = await t.many('SELECT invoice_id FROM payment_lines WHERE payment_id = ?', [id]);
    for (const line of lines) {
      await t.run("UPDATE invoices SET status = 'approved_for_payment', bank_account_id = NULL WHERE id = ?", [line.invoice_id]);
    }
    await t.run("UPDATE payments SET status = 'voided' WHERE id = ?", [id]);
    await logAction({ userId: actor.id, action: 'payment.void', entityType: 'payment', entityId: id, details: { reason } }, t);
  });

  return getPaymentDetail(id, x);
}

export async function getPaymentDetail(id, x = getExecutor()) {
  const payment = await x.one(
    `SELECT p.*, ba.display_name AS bank_account_name
       FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id
      WHERE p.id = ?`,
    [id],
  );
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  payment.lines = await x.many(
    `SELECT pl.*, i.invoice_number, i.doc_type, i.invoice_date, s.name AS supplier_name
       FROM payment_lines pl
       JOIN invoices i ON i.id = pl.invoice_id
       JOIN suppliers s ON s.id = i.supplier_id
      WHERE pl.payment_id = ?`,
    [id],
  );
  return payment;
}

/** Assemble everything needed to render a Standard-501 check for a payment (stage 4). */
export async function getCheckPrintData(id, x = getExecutor()) {
  const payment = await getPaymentDetail(id, x);
  if (payment.method !== 'check') {
    throw new RuleError('PRINT', 'הדפסת צ׳ק זמינה רק לתשלום מסוג צ׳ק');
  }
  const account = await x.one(
    `SELECT ba.*, c.name AS company_name, c.tax_id AS company_tax_id
       FROM bank_accounts ba JOIN companies c ON c.id = ba.company_id
      WHERE ba.id = ?`,
    [payment.bank_account_id],
  );

  const payees = (
    await x.many(
      `SELECT DISTINCT s.name FROM payment_lines pl
         JOIN invoices i ON i.id = pl.invoice_id
         JOIN suppliers s ON s.id = i.supplier_id
        WHERE pl.payment_id = ?`,
      [id],
    )
  ).map((r) => r.name);

  return {
    payment,
    account,
    payees,
    amountWords: amountToHebrewWords(payment.amount),
    approved: config.checkPrinting.approved,
  };
}

export async function listPayments({ status = null, companyId = null, storeId = null, scope = null } = {}, x = getExecutor()) {
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
  if (scope != null) {
    if (scope.length === 0) where.push('1 = 0');
    else { where.push(`ba.company_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
  }
  const sql = `SELECT p.*, ba.display_name AS bank_account_name,
                      c.name AS company_name, st.name AS store_name
                 FROM payments p
                 JOIN bank_accounts ba ON ba.id = p.bank_account_id
                 JOIN companies c ON c.id = ba.company_id
                 JOIN stores st ON st.id = ba.store_id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY p.id DESC`;
  return x.many(sql, params);
}

/** Lookup payments by (last digits of) check number / transfer reference / batch number. */
export async function lookupChecks(query, scope = null, x = getExecutor()) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;
  const sc = scopeClause(scope, 'ba.company_id');
  // Correlated subquery for one supplier name -> one row per payment, portable across SQLite/Postgres.
  return x.many(
    `SELECT p.id, p.method, p.check_number, p.reference, p.batch_number,
            p.payment_date, p.amount, p.status,
            ba.display_name AS bank_account_name,
            (SELECT s.name FROM payment_lines pl
               JOIN invoices i ON i.id = pl.invoice_id
               JOIN suppliers s ON s.id = i.supplier_id
              WHERE pl.payment_id = p.id
              ORDER BY pl.id LIMIT 1) AS supplier_name
       FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
      WHERE (p.check_number LIKE ? OR p.reference LIKE ? OR p.batch_number LIKE ?)${sc.sql}
      ORDER BY p.id DESC`,
    [like, like, like, ...sc.params],
  );
}
