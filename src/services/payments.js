import { getExecutor, tx } from '../db/adapter.js';
import { config } from '../config.js';
import { NotFoundError, RuleError, AuthError } from '../lib/errors.js';
import { userCan } from '../lib/permissions.js';
import { scopeClause, scopeWhere } from '../lib/scope.js';
import { parseSearchTerms, anyTermLike } from '../lib/search.js';
import { amountToHebrewWords } from '../lib/hebrewAmount.js';
import { notify } from '../lib/notify.js';
import { israelToday } from '../lib/loginHours.js';
import { logAction } from './audit.js';
import { syncInvoicePaidStatus } from './allocations.js';
import { supplierFamilyIds } from './suppliers.js';

const METHODS = ['check', 'cash', 'credit', 'transfer', 'batch', 'standing_order'];

/** Parse supplier payment-terms text → number of days (מיידי = 0, "שוטף 30" = 30). null if unknown. */
export function parsePaymentTermsDays(terms) {
  const t = String(terms || '').trim();
  if (!t) return null;
  if (/מיידי/.test(t)) return 0;
  const m = t.match(/\d+/);
  return m ? Number(m[0]) : null;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00`);
  const b = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Which paid invoices were paid EARLIER than the supplier's payment terms (§7 — Telegram push).
 *
 * The terms clock starts at the TAX INVOICE only: a credit note (`docType === 'credit_note'`)
 * reduces the amount, it never sets the due date. When one payment nets several tax invoices of
 * the same supplier, the EARLIEST tax-invoice date is the basis (its terms window closes first),
 * so a supplier yields at most one alert. Rows without a `docType` count as tax invoices.
 * @param {Array<{supplierId?,supplierName,invoiceNumber,invoiceDate,terms,docType?}>} rows
 * @param {string} paymentDate ISO date
 * @returns {Array<{supplierName,invoiceNumber,termsDays,actualDays,earlyDays,invoiceDate}>}
 */
export function earlyPaymentAlerts(rows, paymentDate) {
  // Earliest tax invoice per supplier.
  const basis = new Map();
  for (const r of rows || []) {
    if (r.docType === 'credit_note') continue;
    const key = r.supplierId != null ? `#${r.supplierId}` : `n:${r.supplierName || ''}`;
    const prev = basis.get(key);
    if (!prev || String(r.invoiceDate).slice(0, 10) < String(prev.invoiceDate).slice(0, 10)) basis.set(key, r);
  }

  const out = [];
  for (const r of basis.values()) {
    const termsDays = parsePaymentTermsDays(r.terms);
    if (termsDays == null) continue;
    const actual = daysBetween(r.invoiceDate, paymentDate);
    if (actual == null) continue;
    if (actual < termsDays) {
      out.push({
        supplierName: r.supplierName,
        invoiceNumber: r.invoiceNumber,
        invoiceDate: r.invoiceDate,
        termsDays,
        actualDays: actual,
        earlyDays: termsDays - actual,
      });
    }
  }
  return out;
}

/**
 * Issue a payment (check/cash/credit/transfer/batch), in one of two shapes:
 *
 *  • AGAINST INVOICES — pass `invoiceIds`. The amount is the net of those invoices and credit
 *    notes (never typed by hand), each is consumed whole, and R5 holds: amount == Σ lines.
 *  • AS AN ADVANCE (R8) — pass `supplierId` + `amount` and no invoices. This is money paid before
 *    its invoice exists: 12 rent checks handed over up front. The payment carries its supplier so
 *    the invoice can find it later; the whole amount sits unallocated ("על החשבון") until an
 *    invoice is attached with allocateInvoiceToPayments.
 *
 * Enforces the method's identifier either way; R1 (invoice approved_for_payment AND supplier
 * approved) and the cash ceiling on both.
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
    supplierId = null,
    amount: advanceAmount = null,
  } = input;

  if (!METHODS.includes(method)) throw new RuleError('VALIDATION', `אמצעי תשלום לא תקין: ${method}`);
  if (!paymentDate) throw new RuleError('VALIDATION', 'תאריך תשלום חובה');

  // An advance replaces the invoices, never joins them: with invoices the amount is DERIVED, and
  // accepting a typed amount alongside them would be a way to break R5.
  const isAdvance = !Array.isArray(invoiceIds) || invoiceIds.length === 0;
  if (isAdvance) {
    if (!supplierId) {
      throw new RuleError('R8', 'תשלום על החשבון (ללא חשבונית) — חובה לבחור ספק, אחרת לא נדע למי שולם');
    }
    if (!Number.isFinite(Number(advanceAmount)) || Number(advanceAmount) <= 0) {
      throw new RuleError('R8', 'תשלום על החשבון — חובה סכום חיובי');
    }
  } else if (advanceAmount != null) {
    throw new RuleError('R5', 'כשמצורפות חשבוניות הסכום נגזר מהן — לא ניתן להזין סכום ידני');
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
    // 4 ספרות אחרונות אינן חובה; אם הוזנו — הן חייבות להיות בדיוק 4 ספרות.
    const last4 = String(cardLast4 || '').trim();
    if (last4 && !/^\d{4}$/.test(last4)) throw new RuleError('VALIDATION', 'תשלום אשראי — 4 הספרות האחרונות חייבות להיות בדיוק 4 ספרות');
    fields.card_last4 = last4 || null;
  } else if (method === 'transfer') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'העברה — מספר אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'standing_order') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'הו"ק — מספר הרשאה / אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'batch') {
    if (!batchNumber || !String(batchNumber).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר מקבץ חובה');
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר אסמכתא חובה');
    fields.batch_number = String(batchNumber).trim();
    fields.reference = String(reference).trim();
  }

  const account = await x.one('SELECT * FROM bank_accounts WHERE id = ?', [bankAccountId]);
  if (!account) throw new NotFoundError(`חשבון בנק ${bankAccountId} לא נמצא`);

  // Friendly guard for a duplicate check number (a voided check released its number, so it's free).
  if (fields.check_number) {
    const dup = await x.one(
      "SELECT id FROM payments WHERE bank_account_id = ? AND check_number = ? AND status <> 'voided'",
      [account.id, fields.check_number],
    );
    if (dup) throw new RuleError('CHECK', `מספר צ׳ק ${fields.check_number} כבר קיים בחשבון זה (תשלום #${dup.id}). אם זה תיקון — בטל את הצ׳ק הקודם ואז אפשר להשתמש שוב באותו מספר.`);
  }

  // Collected for the "paid earlier than terms" Telegram alert, evaluated after commit.
  const termsRows = [];

  const paymentId = await tx(async (t) => {
    let net = 0;
    const lines = [];
    // The supplier family every invoice on this payment must belong to (set by the first one).
    let family = null;
    let familyName = null;

    if (isAdvance) {
      // No lines: the whole amount is on account until an invoice is allocated against it.
      const sup = await t.one('SELECT id, name, status FROM suppliers WHERE id = ?', [supplierId]);
      if (!sup) throw new NotFoundError(`ספק ${supplierId} לא נמצא`);
      if (sup.status !== 'approved') {
        throw new RuleError('R1', `הספק "${sup.name}" אינו מאושר (status=${sup.status}) — תשלום חסום`);
      }
      net = Math.round(Number(advanceAmount));
    }

    for (const invId of isAdvance ? [] : invoiceIds) {
      const inv = await t.one(
        `SELECT i.*, s.status AS supplier_status, s.name AS supplier_name, s.payment_terms AS supplier_terms,
                ba.id AS store_bank_account_id
           FROM invoices i
           JOIN suppliers s ON s.id = i.supplier_id
           JOIN bank_accounts ba ON ba.store_id = i.store_id
          WHERE i.id = ?`,
        [invId],
      );
      if (!inv) throw new NotFoundError(`חשבונית ${invId} לא נמצאה`);
      // docType matters: the alert's clock starts at the earliest TAX invoice, never at a credit note.
      termsRows.push({ supplierId: inv.supplier_id, supplierName: inv.supplier_name, invoiceNumber: inv.invoice_number, invoiceDate: inv.invoice_date, terms: inv.supplier_terms, docType: inv.doc_type });

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
      // One payment settles ONE supplier — you cannot hand a supplier a check that also covers
      // another supplier's invoice. The exception is a supplier FAMILY (a subsidiary and its
      // parent, e.g. טרה under קוקה קולה), which bills separately but is paid together.
      if (family === null) {
        family = new Set(await supplierFamilyIds(inv.supplier_id, t));
        familyName = inv.supplier_name;
      } else if (!family.has(Number(inv.supplier_id))) {
        throw new RuleError(
          'R1',
          `לא ניתן לשלם בתשלום אחד לספקים שונים: "${familyName}" ו-"${inv.supplier_name}". ` +
            'תשלום מרוכז אפשרי רק לספק אחד או לחברת-בת שלו. הנפק תשלום נפרד לכל ספק.',
          { invoiceId: inv.id },
        );
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
          payment_date, amount, status, supplier_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`,
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
        // Recorded for an advance (there are no lines to derive it from). For an invoice-backed
        // payment the lines already carry the supplier, so it stays NULL as before.
        isAdvance ? supplierId : null,
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
      // Concurrency guard against a double payment (double-submit / two racing requests): flip to
      // 'paid' ONLY if the invoice is still payable. Under Postgres READ COMMITTED the second
      // transaction blocks on this row until the first commits, then re-checks the WHERE against
      // the now-'paid' row → 0 rows changed → we abort and roll back the whole payment. (SQLite
      // serializes writers, so it's inherently safe there; this keeps both backends consistent.)
      const upd = await t.run(
        "UPDATE invoices SET status = 'paid', bank_account_id = ? WHERE id = ? AND status IN ('recorded', 'approved_for_payment')",
        [account.id, line.invoiceId],
      );
      if (!upd.changes) {
        throw new RuleError('R2', `חשבונית #${line.invoiceId} כבר שולמה או שונתה בו-זמנית — התשלום בוטל. רענן ונסה שוב.`, { invoiceId: line.invoiceId });
      }
    }

    // R5: with invoices attached the amount must equal their net exactly. An advance has no lines
    // yet, so the rule relaxes to "never allocate more than was paid" — Σ lines ≤ amount.
    const sumRow = await t.one('SELECT COALESCE(SUM(amount_applied),0) AS s FROM payment_lines WHERE payment_id = ?', [pid]);
    if (isAdvance ? Number(sumRow.s) > net : Number(sumRow.s) !== net) {
      throw new RuleError('R5', `אי-התאמה בין סכום הצ׳ק (${net}) לסכום השורות (${sumRow.s})`);
    }

    await logAction(
      { userId: actor.id, action: 'payment.create', entityType: 'payment', entityId: pid, details: { method, ...fields, amount: net, invoiceIds, advance: isAdvance || undefined, supplierId: isAdvance ? supplierId : undefined } },
      t,
    );
    return pid;
  });

  // Best-effort Telegram push if any invoice was paid earlier than its supplier's terms (§7).
  try {
    const alerts = earlyPaymentAlerts(termsRows, paymentDate);
    if (alerts.length) {
      const lines = alerts.map(
        (a) => `• ${a.supplierName} · חשבונית מס ${a.invoiceNumber}: שולם ${a.actualDays} ימים מתאריך החשבונית (תנאי ${a.termsDays} ימים) — מוקדם ב-${a.earlyDays} ימים`,
      );
      notify(`⏱️ <b>תשלום מוקדם מתנאי התשלום</b>\n${lines.join('\n')}`);
    }
  } catch { /* alerts are best-effort */ }

  return getPaymentDetail(paymentId, x);
}

// Per-method identifier validation → the columns to store. Shared shape with createPayment.
function methodIdentifierFields({ method, checkNumber, reference, payerName, cardLast4, batchNumber }) {
  const fields = { check_number: null, reference: null, payer_name: null, card_last4: null, batch_number: null };
  if (method === 'check') {
    if (!checkNumber || !String(checkNumber).trim()) throw new RuleError('CHECK', 'לא ניתן להנפיק צ׳ק ללא מספר צ׳ק');
    fields.check_number = String(checkNumber).trim();
  } else if (method === 'cash') {
    if (!payerName || !String(payerName).trim()) throw new RuleError('VALIDATION', 'תשלום מזומן — שם המשלם חובה');
    fields.payer_name = String(payerName).trim();
  } else if (method === 'credit') {
    const last4 = String(cardLast4 || '').trim();
    if (last4 && !/^\d{4}$/.test(last4)) throw new RuleError('VALIDATION', 'תשלום אשראי — 4 הספרות האחרונות חייבות להיות בדיוק 4 ספרות');
    fields.card_last4 = last4 || null;
  } else if (method === 'transfer') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'העברה — מספר אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'standing_order') {
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'הו"ק — מספר הרשאה / אסמכתא חובה');
    fields.reference = String(reference).trim();
  } else if (method === 'batch') {
    if (!batchNumber || !String(batchNumber).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר מקבץ חובה');
    if (!reference || !String(reference).trim()) throw new RuleError('VALIDATION', 'מקבץ — מספר אסמכתא חובה');
    fields.batch_number = String(batchNumber).trim();
    fields.reference = String(reference).trim();
  }
  return fields;
}

/**
 * Edit an existing payment's method / identifier / payment date. The amount and the invoices it is
 * applied to are NOT changed here (that would re-open R5 and the invoice paid-state); to re-target
 * invoices, void this payment and issue a new one. A voided payment can't be edited.
 */
export async function updatePayment(id, input, actor, x = getExecutor()) {
  const existing = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!existing) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  if (existing.status === 'voided') throw new RuleError('VALIDATION', 'לא ניתן לערוך תשלום מבוטל');
  const method = input.method || existing.method;
  if (!METHODS.includes(method)) throw new RuleError('VALIDATION', `אמצעי תשלום לא תקין: ${method}`);
  const paymentDate = input.paymentDate || existing.payment_date;
  if (!paymentDate) throw new RuleError('VALIDATION', 'תאריך תשלום חובה');
  const fields = methodIdentifierFields({ ...input, method });

  // Check number stays unique within the bank account — among LIVE payments only (a voided check
  // released its number), and excluding this same payment.
  if (fields.check_number) {
    const dup = await x.one(
      "SELECT id FROM payments WHERE bank_account_id = ? AND check_number = ? AND status <> 'voided' AND id <> ?",
      [existing.bank_account_id, fields.check_number, id],
    );
    if (dup) throw new RuleError('VALIDATION', `מספר צ׳ק ${fields.check_number} כבר קיים בחשבון זה`);
  }

  // Optional: re-target the invoices this payment applies to (e.g. add a credit note so the net
  // becomes the real check amount). Allowed only for an issued, not-bank-matched payment. The
  // amount is recomputed from the selected invoices (R5) — never edited to an arbitrary value.
  const retarget = Array.isArray(input.invoiceIds) && input.invoiceIds.length > 0;

  await tx(async (t) => {
    if (retarget) {
      if (existing.status !== 'issued') throw new RuleError('VALIDATION', 'שינוי החשבוניות המשויכות אפשרי רק לתשלום שהונפק (לא נפרע/מבוטל)');
      const matched = await t.one('SELECT 1 AS m FROM bank_transactions WHERE matched_payment_id = ? LIMIT 1', [id]);
      if (matched) throw new RuleError('VALIDATION', 'התשלום מותאם לתנועת בנק — בטל את ההתאמה לפני שינוי החשבוניות');

      const curIds = new Set((await t.many('SELECT invoice_id FROM payment_lines WHERE payment_id = ?', [id])).map((r) => Number(r.invoice_id)));
      const newIds = [...new Set(input.invoiceIds.map(Number).filter(Boolean))];
      let net = 0;
      const lines = [];
      let family = null;
      let familyName = null;
      for (const invId of newIds) {
        const inv = await t.one(
          `SELECT i.*, s.status AS supplier_status, s.name AS supplier_name, ba.id AS store_bank_account_id
             FROM invoices i JOIN suppliers s ON s.id = i.supplier_id JOIN bank_accounts ba ON ba.store_id = i.store_id
            WHERE i.id = ?`,
          [invId],
        );
        if (!inv) throw new NotFoundError(`חשבונית ${invId} לא נמצאה`);
        const okStatus = ['recorded', 'approved_for_payment'].includes(inv.status) || (inv.status === 'paid' && curIds.has(invId));
        if (!okStatus) throw new RuleError('R1', `חשבונית #${inv.id}: סטטוס "${inv.status}" — לא ניתן לשייך לתשלום`, { invoiceId: inv.id });
        if (inv.supplier_status !== 'approved') throw new RuleError('R1', `הספק "${inv.supplier_name}" אינו מאושר — תשלום חסום`, { invoiceId: inv.id });
        if (inv.store_bank_account_id !== existing.bank_account_id) throw new RuleError('ACCOUNT', `חשבונית #${inv.id} משויכת לחשבון בנק אחר`, { invoiceId: inv.id });
        // Same one-supplier-family rule as createPayment — a re-target must not smuggle in a
        // second supplier's invoice.
        if (family === null) {
          family = new Set(await supplierFamilyIds(inv.supplier_id, t));
          familyName = inv.supplier_name;
        } else if (!family.has(Number(inv.supplier_id))) {
          throw new RuleError(
            'R1',
            `לא ניתן לשלם בתשלום אחד לספקים שונים: "${familyName}" ו-"${inv.supplier_name}".`,
            { invoiceId: inv.id },
          );
        }
        net += inv.total_amount;
        lines.push({ invoiceId: inv.id, amountApplied: inv.total_amount });
      }
      if (net <= 0) throw new RuleError('R5', `נטו לתשלום הוא ${net / 100} ₪ — לא ניתן לתשלום בסכום אפס או שלילי`);
      if (method === 'cash' && config.cashCeilingAgorot > 0 && net > config.cashCeilingAgorot) {
        throw new RuleError('CASH_LIMIT', `תשלום במזומן מוגבל ל-${config.cashCeilingAgorot / 100} ₪ לפי חוק צמצום השימוש במזומן.`);
      }
      // Invoices dropped from this payment revert to unpaid ('recorded'); kept/added become 'paid'.
      await t.run('DELETE FROM payment_lines WHERE payment_id = ?', [id]);
      for (const l of lines) {
        await t.run('INSERT INTO payment_lines (payment_id, invoice_id, amount_applied) VALUES (?, ?, ?)', [id, l.invoiceId, l.amountApplied]);
      }
      // Recompute every invoice this payment touched — dropped ones AND kept ones. Since R8 an
      // invoice may be covered by other payments too, so "dropped from this check" no longer
      // means "unpaid": syncInvoicePaidStatus is the only thing allowed to decide that.
      for (const invId of new Set([...curIds, ...newIds])) {
        await syncInvoicePaidStatus(invId, existing.bank_account_id, t);
      }
      await t.run(
        `UPDATE payments SET method = ?, check_number = ?, reference = ?, payer_name = ?, card_last4 = ?, batch_number = ?, payment_date = ?, amount = ? WHERE id = ?`,
        [method, fields.check_number, fields.reference, fields.payer_name, fields.card_last4, fields.batch_number, paymentDate, net, id],
      );
    } else {
      // Plain edit (no retarget): the amount is unchanged, but the method may have switched to
      // cash — enforce the cash ceiling here too, or a large check could be relabelled 'cash'
      // above the legal limit without recomputing.
      if (method === 'cash' && config.cashCeilingAgorot > 0 && existing.amount > config.cashCeilingAgorot) {
        throw new RuleError('CASH_LIMIT', `תשלום במזומן מוגבל ל-${config.cashCeilingAgorot / 100} ₪ לפי חוק צמצום השימוש במזומן.`);
      }
      await t.run(
        `UPDATE payments SET method = ?, check_number = ?, reference = ?, payer_name = ?, card_last4 = ?, batch_number = ?, payment_date = ? WHERE id = ?`,
        [method, fields.check_number, fields.reference, fields.payer_name, fields.card_last4, fields.batch_number, paymentDate, id],
      );
    }
  });
  await logAction({ userId: actor?.id ?? null, action: 'payment.update', entityType: 'payment', entityId: id, details: { method, ...fields, paymentDate, retarget } }, x);
  return getPaymentDetail(id, x);
}

/** Manually mark a check as cleared (stage-1 manual reconciliation; R7 automates this in stage 2). */
export async function markCleared(id, clearedDate, actor, x = getExecutor()) {
  const payment = await x.one('SELECT * FROM payments WHERE id = ?', [id]);
  if (!payment) throw new NotFoundError(`תשלום ${id} לא נמצא`);
  if (payment.status === 'voided') throw new RuleError('R', 'צ׳ק מבוטל — לא ניתן לסמן כנפרע');

  await x.run("UPDATE payments SET status = 'cleared', cleared_date = ? WHERE id = ?", [
    clearedDate || israelToday(),
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
  // Idempotency guard: voiding an already-voided check would re-revert its invoices to
  // approved_for_payment, silently un-doing any later state (e.g. re-paid on a new check).
  if (payment.status === 'voided') throw new RuleError('R', 'הצ׳ק כבר בוטל');
  // A payment may be voided ONLY while it is still 'issued' and NOT reconciled to the bank —
  // once the money went through it is irreversible; the correction there is a stop-payment / a
  // manual credit, not a void. The bank-match check comes first (a matched payment is also
  // 'cleared', and its message is the more actionable one). To void either, first unmatch and
  // revert the clear (markIssued).
  const matched = await x.one('SELECT 1 AS m FROM bank_transactions WHERE matched_payment_id = ? LIMIT 1', [id]);
  if (matched) throw new RuleError('R', 'התשלום הותאם לתנועת בנק — בטל את ההתאמה תחילה, ורק אז ניתן לבטל.');
  if (payment.status !== 'issued') throw new RuleError('R', 'תשלום שנפרע — לא ניתן לבטל (הכסף כבר עבר). שחרר את הפירעון תחילה אם זו טעות.');

  await tx(async (t) => {
    const lines = await t.many('SELECT invoice_id FROM payment_lines WHERE payment_id = ?', [id]);
    // Void FIRST, then recompute: an invoice may be covered by several payments now (R8), so
    // whether it stays 'paid' depends on the allocations that REMAIN live — blindly reverting it
    // to approved_for_payment would re-open an invoice the other checks still cover.
    await t.run("UPDATE payments SET status = 'voided' WHERE id = ?", [id]);
    for (const line of lines) {
      await syncInvoicePaidStatus(line.invoice_id, null, t);
    }
    await logAction({ userId: actor.id, action: 'payment.void', entityType: 'payment', entityId: id, details: { reason } }, t);
  });

  return getPaymentDetail(id, x);
}

export async function getPaymentDetail(id, x = getExecutor()) {
  const payment = await x.one(
    `SELECT p.*, ba.display_name AS bank_account_name,
            CASE WHEN mt.matched_payment_id IS NOT NULL THEN 1 ELSE 0 END AS auto_cleared
       FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
       LEFT JOIN (SELECT DISTINCT matched_payment_id FROM bank_transactions WHERE matched_payment_id IS NOT NULL) mt
              ON mt.matched_payment_id = p.id
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

  // Code line built from the fields a bank MICR line carries. It renders in the approved MICR
  // font only when both flags are on; until then the print view labels it a placeholder. The
  // exact symbol layout must match the bank's spec before real issuance (CMC-7 in Israel).
  const micrLine = `⑈${payment.check_number || ''}⑈ ⑆${account?.branch || ''} ${account?.account_number || ''}⑆`;
  const approved = config.checkPrinting.approved;
  const micrReady = approved && config.checkPrinting.micrFontInstalled;

  return {
    payment,
    account,
    payees,
    amountWords: amountToHebrewWords(payment.amount),
    micrLine,
    approved,
    micrReady,
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
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  if (sc.sql) { where.push(sc.sql.replace(/^ AND /, '')); params.push(...sc.params); }
  const sql = `SELECT p.*, ba.display_name AS bank_account_name,
                      c.name AS company_name, st.name AS store_name,
                      CASE WHEN mt.matched_payment_id IS NOT NULL THEN 1 ELSE 0 END AS auto_cleared
                 FROM payments p
                 JOIN bank_accounts ba ON ba.id = p.bank_account_id
                 JOIN companies c ON c.id = ba.company_id
                 JOIN stores st ON st.id = ba.store_id
                 LEFT JOIN (SELECT DISTINCT matched_payment_id FROM bank_transactions WHERE matched_payment_id IS NOT NULL) mt
                        ON mt.matched_payment_id = p.id
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY p.id DESC`;
  return x.many(sql, params);
}

/** Lookup payments by (last digits of) check number / transfer reference / batch number. */
export async function lookupChecks(query, scope = null, x = getExecutor()) {
  const terms = parseSearchTerms(query);
  if (!terms.length) return [];
  const m = anyTermLike(terms, ['p.check_number', 'p.reference', 'p.batch_number']);
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  // Correlated subquery for one supplier name -> one row per payment, portable across SQLite/Postgres.
  return x.many(
    `SELECT p.id, p.method, p.check_number, p.reference, p.batch_number,
            p.payer_name, p.card_last4,
            p.payment_date, p.amount, p.status,
            ba.display_name AS bank_account_name,
            (SELECT s.name FROM payment_lines pl
               JOIN invoices i ON i.id = pl.invoice_id
               JOIN suppliers s ON s.id = i.supplier_id
              WHERE pl.payment_id = p.id
              ORDER BY pl.id LIMIT 1) AS supplier_name
       FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
      WHERE ${m.sql}${sc.sql}
      ORDER BY p.id DESC`,
    [...m.params, ...sc.params],
  );
}
