import { getExecutor } from '../db/adapter.js';
import { config } from '../config.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { userCan } from '../lib/permissions.js';
import { scopeClause } from '../lib/scope.js';
import { logAction } from './audit.js';

const DOC_TYPES = ['tax_invoice', 'tax_invoice_receipt', 'credit_note'];

/** Add `days` (may be negative) to an ISO 'YYYY-MM-DD' date, returning ISO. Portable across DBs. */
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Record a new invoice (or credit note). Enforces the entry-time control rules:
 *   R2 — duplicate detection (allocation_number is a hard block; supplier+number is a soft warning)
 *   R3 — tax invoice over the allocation threshold with no allocation number => soft block (on_hold)
 *   R4 — same supplier + same total within the duplicate window => soft warning
 *
 * @returns {{invoice: object, warnings: Array<{code:string,message:string}>}}
 */
export async function createInvoice(input, actor, x = getExecutor()) {
  const {
    supplierId,
    storeId,
    invoiceNumber,
    allocationNumber = null,
    invoiceDate,
    amountBeforeVat, // agorot
    vatAmount = 0, // agorot
    docType,
    imagePath = null, // stage 1b — filename under uploads/
    confirm = false,
    confirmReason = null,
  } = input;

  // ---- basic validation -------------------------------------------------------
  if (!DOC_TYPES.includes(docType)) {
    throw new RuleError('VALIDATION', `סוג מסמך לא תקין: ${docType}`);
  }
  if (!invoiceNumber || !String(invoiceNumber).trim()) {
    throw new RuleError('VALIDATION', 'מספר חשבונית חובה');
  }
  if (!invoiceDate) throw new RuleError('VALIDATION', 'תאריך חשבונית חובה');

  const supplier = await x.one('SELECT * FROM suppliers WHERE id = ?', [supplierId]);
  if (!supplier) throw new NotFoundError(`ספק ${supplierId} לא נמצא`);
  const store = await x.one('SELECT * FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);

  const alloc = normalizeAllocation(allocationNumber);

  // Credit notes are stored negative; other docs positive.
  const sign = docType === 'credit_note' ? -1 : 1;
  const beforeVat = sign * Math.abs(amountBeforeVat);
  const vat = sign * Math.abs(vatAmount);
  const total = beforeVat + vat;

  // ---- R2 (primary): allocation number is a strong key — hard block -----------
  if (alloc) {
    const clash = await x.one('SELECT id FROM invoices WHERE allocation_number = ?', [alloc]);
    if (clash) {
      throw new RuleError(
        'R2',
        `מספר הקצאה ${alloc} כבר קיים במערכת (חשבונית #${clash.id}) — כפילות חסומה`,
        { conflictInvoiceId: clash.id },
      );
    }
  }

  // ---- collect soft warnings (R2-secondary, R4) -------------------------------
  const warnings = [];

  // R2 (secondary): same supplier + same invoice number.
  const sameNumber = await x.one(
    'SELECT id FROM invoices WHERE supplier_id = ? AND invoice_number = ?',
    [supplierId, String(invoiceNumber).trim()],
  );
  if (sameNumber) {
    warnings.push({
      code: 'R2',
      message: `כבר קיימת חשבונית #${sameNumber.id} לספק זה עם מספר ${invoiceNumber} — ודא שאינה כפילות`,
    });
  }

  // R4: same supplier + same total within the duplicate window (window computed in JS -> portable).
  const lo = addDaysIso(invoiceDate, -config.rules.dupWindowDays);
  const hi = addDaysIso(invoiceDate, config.rules.dupWindowDays);
  const dupWindow = await x.one(
    `SELECT id, invoice_date FROM invoices
      WHERE supplier_id = ? AND total_amount = ? AND invoice_date BETWEEN ? AND ?`,
    [supplierId, total, lo, hi],
  );
  if (dupWindow) {
    warnings.push({
      code: 'R4',
      message: `סכום זהה (${total / 100} ₪) לאותו ספק בחשבונית #${dupWindow.id} מ-${dupWindow.invoice_date} — ודא שאינה כפילות`,
    });
  }

  if (warnings.length && !confirm) {
    throw new RuleError('WARN', 'נמצאו אזהרות כפילות — נדרש אישור להמשך', {
      warnings,
      needsConfirmation: true,
    });
  }

  // ---- R3: tax invoice over threshold with no allocation => soft block --------
  const r3Triggered =
    docType === 'tax_invoice' &&
    !alloc &&
    Math.abs(beforeVat) > config.rules.allocationThresholdAgorot;
  const status = r3Triggered ? 'on_hold' : 'recorded';
  const holdReason = r3Triggered
    ? `R3: חשבונית מס מעל ${config.rules.allocationThresholdAgorot / 100} ₪ ללא מספר הקצאה — חסום לתשלום עד השלמת הקצאה או עקיפת בעלים`
    : null;

  const info = await x.run(
    `INSERT INTO invoices
       (supplier_id, company_id, store_id, invoice_number, allocation_number,
        invoice_date, amount_before_vat, vat_amount, total_amount, doc_type,
        image_path, status, hold_reason, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      supplierId,
      store.company_id,
      storeId,
      String(invoiceNumber).trim(),
      alloc,
      invoiceDate,
      beforeVat,
      vat,
      total,
      docType,
      imagePath,
      status,
      holdReason,
      actor.id,
    ],
  );

  await logAction(
    {
      userId: actor.id,
      action: 'invoice.create',
      entityType: 'invoice',
      entityId: info.lastInsertRowid,
      details: {
        docType,
        total,
        status,
        r3Triggered,
        dismissedWarnings: warnings.map((w) => w.code),
        confirmReason: warnings.length ? confirmReason : null,
      },
    },
    x,
  );

  return { invoice: await getInvoice(info.lastInsertRowid, x), warnings };
}

/**
 * Approve an invoice for payment.
 */
export async function approveInvoiceForPayment(id, actor, x = getExecutor()) {
  const invoice = await getInvoice(id, x);
  if (invoice.status === 'paid') {
    throw new RuleError('R', 'חשבונית ששולמה — לא ניתן לאשר מחדש');
  }
  if (invoice.status === 'approved_for_payment') return invoice;

  const r3Blocks =
    invoice.status === 'on_hold' ||
    (invoice.doc_type === 'tax_invoice' &&
      !invoice.allocation_number &&
      Math.abs(invoice.amount_before_vat) > config.rules.allocationThresholdAgorot);

  if (r3Blocks && !userCan(actor, 'hold_invoice')) {
    throw new AuthError(
      'חשבונית זו חסומה לתשלום (R3/on_hold). שחרור/עקיפה — נדרשת הרשאת החזקת חשבונית (R6)',
    );
  }

  await x.run(
    "UPDATE invoices SET status = 'approved_for_payment', hold_reason = NULL WHERE id = ?",
    [id],
  );

  await logAction(
    {
      userId: actor.id,
      action: 'invoice.approve_for_payment',
      entityType: 'invoice',
      entityId: id,
      details: { ownerOverride: r3Blocks && actor.role === 'owner' },
    },
    x,
  );
  return getInvoice(id, x);
}

/** Put an invoice on hold — owner only (R6). */
export async function putOnHold(id, reason, actor, x = getExecutor()) {
  if (!userCan(actor, 'hold_invoice')) throw new AuthError('החזקה/שחרור חשבונית — נדרשת הרשאת החזקת חשבונית (R6)');
  const invoice = await getInvoice(id, x);
  if (invoice.status === 'paid') throw new RuleError('R', 'חשבונית ששולמה — לא ניתן להחזיק');
  await x.run("UPDATE invoices SET status = 'on_hold', hold_reason = ? WHERE id = ?", [
    reason || 'הוחזק ידנית ע"י בעלים',
    id,
  ]);
  await logAction({ userId: actor.id, action: 'invoice.hold', entityType: 'invoice', entityId: id, details: { reason } }, x);
  return getInvoice(id, x);
}

/**
 * Release a held invoice back to 'recorded'. Requires manager/owner authority: hold_invoice
 * (החזקה/שחרור) or approve_payment (מנהל חנות). A plain secretary cannot flip a hold placed by
 * an owner/manager — they must file a change request instead (routes/invoices.js).
 */
export async function releaseHold(id, actor, x = getExecutor()) {
  if (!userCan(actor, 'hold_invoice') && !userCan(actor, 'approve_payment')) {
    throw new AuthError('שחרור החזקה — נדרשת הרשאת מנהל/בעלים');
  }
  const invoice = await getInvoice(id, x);
  if (invoice.status === 'paid') throw new RuleError('R', 'חשבונית ששולמה — לא ניתן לשנות');
  if (invoice.status !== 'on_hold') return invoice;
  await x.run("UPDATE invoices SET status = 'recorded', hold_reason = NULL WHERE id = ?", [id]);
  await logAction({ userId: actor.id, action: 'invoice.release_hold', entityType: 'invoice', entityId: id }, x);
  return getInvoice(id, x);
}

/**
 * Self-heal a stale automatic R3 hold. If an invoice is on_hold with an R3 reason but no longer
 * qualifies — the amount dropped below the allocation threshold, an allocation number was added,
 * or the doc type changed — move it back to 'recorded'. Idempotent; safe to call on every view.
 * This fixes invoices that were flagged R3 before the amount was corrected below 5,000 ₪.
 */
export async function reconcileR3Hold(id, x = getExecutor()) {
  const inv = await getInvoice(id, x);
  if (inv.status !== 'on_hold') return inv;
  if (typeof inv.hold_reason !== 'string' || !inv.hold_reason.startsWith('R3')) return inv;
  const stillR3 =
    inv.doc_type === 'tax_invoice' &&
    !inv.allocation_number &&
    Math.abs(inv.amount_before_vat) > config.rules.allocationThresholdAgorot;
  if (stillR3) return inv;
  await x.run("UPDATE invoices SET status = 'recorded', hold_reason = NULL WHERE id = ?", [id]);
  return getInvoice(id, x);
}

/**
 * Set/replace the allocation number on an invoice.
 */
export async function setAllocationNumber(id, allocationNumber, actor, x = getExecutor()) {
  const invoice = await getInvoice(id, x);
  const alloc = normalizeAllocation(allocationNumber);
  if (!alloc) throw new RuleError('VALIDATION', 'מספר הקצאה חייב להיות 9 ספרות');

  const clash = await x.one('SELECT id FROM invoices WHERE allocation_number = ? AND id <> ?', [alloc, id]);
  if (clash) {
    throw new RuleError('R2', `מספר הקצאה ${alloc} כבר קיים (חשבונית #${clash.id})`, {
      conflictInvoiceId: clash.id,
    });
  }

  const clearsHold = invoice.status === 'on_hold';
  await x.run(
    `UPDATE invoices
        SET allocation_number = ?,
            status = CASE WHEN status = 'on_hold' THEN 'recorded' ELSE status END,
            hold_reason = CASE WHEN status = 'on_hold' THEN NULL ELSE hold_reason END
      WHERE id = ?`,
    [alloc, id],
  );

  await logAction(
    { userId: actor.id, action: 'invoice.set_allocation', entityType: 'invoice', entityId: id, details: { allocationNumber: alloc, clearsHold } },
    x,
  );
  return getInvoice(id, x);
}

/**
 * Edit an invoice's core fields (supplier, store, number, allocation, date, amounts, type).
 * Allowed while the invoice is not yet paid. Recomputes sign/total and re-checks the
 * allocation-number uniqueness. Owner-or-secretary; paid invoices are locked.
 */
export async function updateInvoice(id, input, actor, x = getExecutor()) {
  const invoice = await getInvoice(id, x);
  if (invoice.status === 'paid') throw new RuleError('R', 'חשבונית ששולמה — לא ניתן לערוך');

  const {
    supplierId = invoice.supplier_id,
    storeId = invoice.store_id,
    invoiceNumber = invoice.invoice_number,
    allocationNumber = invoice.allocation_number,
    invoiceDate = invoice.invoice_date,
    amountBeforeVat, // agorot (magnitude)
    vatAmount, // agorot (magnitude)
    docType = invoice.doc_type,
  } = input;

  if (!DOC_TYPES.includes(docType)) throw new RuleError('VALIDATION', `סוג מסמך לא תקין: ${docType}`);
  if (!invoiceNumber || !String(invoiceNumber).trim()) throw new RuleError('VALIDATION', 'מספר חשבונית חובה');
  if (!invoiceDate) throw new RuleError('VALIDATION', 'תאריך חשבונית חובה');

  const supplier = await x.one('SELECT id FROM suppliers WHERE id = ?', [supplierId]);
  if (!supplier) throw new NotFoundError(`ספק ${supplierId} לא נמצא`);
  const store = await x.one('SELECT id, company_id FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);

  const alloc = normalizeAllocation(allocationNumber);
  if (alloc) {
    const clash = await x.one('SELECT id FROM invoices WHERE allocation_number = ? AND id <> ?', [alloc, id]);
    if (clash) throw new RuleError('R2', `מספר הקצאה ${alloc} כבר קיים (חשבונית #${clash.id})`);
  }

  const sign = docType === 'credit_note' ? -1 : 1;
  const beforeVat = sign * Math.abs(amountBeforeVat ?? Math.abs(invoice.amount_before_vat));
  const vat = sign * Math.abs(vatAmount ?? Math.abs(invoice.vat_amount));
  const total = beforeVat + vat;

  await x.run(
    `UPDATE invoices
        SET supplier_id = ?, company_id = ?, store_id = ?, invoice_number = ?, allocation_number = ?,
            invoice_date = ?, amount_before_vat = ?, vat_amount = ?, total_amount = ?, doc_type = ?
      WHERE id = ?`,
    [supplierId, store.company_id, storeId, String(invoiceNumber).trim(), alloc, invoiceDate, beforeVat, vat, total, docType, id],
  );

  // R3 re-evaluation: an automatic hold (placed when the amount was over the allocation
  // threshold) is stale once the invoice no longer qualifies — the amount was corrected below
  // the threshold, an allocation number was added, or the doc type changed. Clear it so the
  // invoice stops showing as "מוחזק (R3)" for a case that no longer applies. Manual owner holds
  // (whose reason does not start with "R3") are never touched here.
  const stillR3 =
    docType === 'tax_invoice' && !alloc && Math.abs(beforeVat) > config.rules.allocationThresholdAgorot;
  if (
    invoice.status === 'on_hold' &&
    typeof invoice.hold_reason === 'string' &&
    invoice.hold_reason.startsWith('R3') &&
    !stillR3
  ) {
    await x.run("UPDATE invoices SET status = 'recorded', hold_reason = NULL WHERE id = ?", [id]);
  }

  await logAction(
    { userId: actor.id, action: 'invoice.update', entityType: 'invoice', entityId: id, details: { total, docType } },
    x,
  );
  return getInvoice(id, x);
}

/**
 * Attach or replace the invoice image (stage 1b). Returns the previous image_path.
 */
export async function setImage(id, imagePath, actor, x = getExecutor()) {
  const invoice = await getInvoice(id, x);
  const previous = invoice.image_path;
  await x.run('UPDATE invoices SET image_path = ? WHERE id = ?', [imagePath, id]);
  await logAction(
    { userId: actor.id, action: 'invoice.set_image', entityType: 'invoice', entityId: id, details: { imagePath } },
    x,
  );
  return previous;
}

// ---- reads -------------------------------------------------------------------

/** Remove the invoice image (and any OCR derived from it). Returns the old ref for cleanup. */
export async function clearImage(id, actor, x = getExecutor()) {
  const invoice = await getInvoice(id, x);
  const previous = invoice.image_path;
  await x.run('UPDATE invoices SET image_path = NULL WHERE id = ?', [id]);
  await x.run('DELETE FROM invoice_ocr WHERE invoice_id = ?', [id]);
  await logAction({ userId: actor.id, action: 'invoice.clear_image', entityType: 'invoice', entityId: id }, x);
  return previous;
}

export async function getInvoice(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM invoices WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`חשבונית ${id} לא נמצאה`);
  return row;
}

/** Invoice with joined supplier / store / company names, for detail views. */
export async function getInvoiceDetail(id, x = getExecutor()) {
  const row = await x.one(
    `SELECT i.*, s.name AS supplier_name, s.status AS supplier_status,
            st.name AS store_name, c.name AS company_name
       FROM invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       JOIN stores st ON st.id = i.store_id
       JOIN companies c ON c.id = i.company_id
      WHERE i.id = ?`,
    [id],
  );
  if (!row) throw new NotFoundError(`חשבונית ${id} לא נמצאה`);
  // Which payment (check) paid this invoice, if any.
  row.payment = await x.one(
    `SELECT p.id, p.check_number, p.payment_date, p.status AS payment_status, p.cleared_date
       FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
      WHERE pl.invoice_id = ?`,
    [id],
  );
  return row;
}

/** List invoices with joined names, optional status filter. */
export async function listInvoices(
  { status = null, scope = null, supplierId = null, storeId = null, q = null, from = null, to = null } = {},
  x = getExecutor(),
) {
  const base = `SELECT i.*, s.name AS supplier_name, s.status AS supplier_status,
                       st.name AS store_name
                  FROM invoices i
                  JOIN suppliers s ON s.id = i.supplier_id
                  JOIN stores st ON st.id = i.store_id`;
  const sc = scopeClause(scope, 'i.company_id');
  let sql = `${base} WHERE 1 = 1`;
  const params = [];
  if (status) { sql += ' AND i.status = ?'; params.push(status); }
  if (supplierId) { sql += ' AND i.supplier_id = ?'; params.push(supplierId); }
  if (storeId) { sql += ' AND i.store_id = ?'; params.push(storeId); }
  if (q) { sql += ' AND i.invoice_number LIKE ?'; params.push(`%${q}%`); }
  if (from) { sql += ' AND i.invoice_date >= ?'; params.push(from); }
  if (to) { sql += ' AND i.invoice_date <= ?'; params.push(to); }
  sql += sc.sql; params.push(...sc.params);
  sql += ' ORDER BY i.id DESC';
  return x.many(sql, params);
}

/**
 * Invoices eligible to be applied to a payment: recorded or approved_for_payment (paying
 * implicitly approves), not on_hold and not yet paid.
 */
export async function listPayable(x = getExecutor()) {
  return x.many(
    `SELECT i.*, s.name AS supplier_name, st.name AS store_name, ba.id AS derived_bank_account_id,
            ba.display_name AS bank_account_name
       FROM invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       JOIN stores st ON st.id = i.store_id
       JOIN bank_accounts ba ON ba.store_id = i.store_id
      WHERE i.status IN ('recorded', 'approved_for_payment')
      ORDER BY s.name, i.invoice_date`,
    [],
  );
}

function normalizeAllocation(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  if (t === '') return null;
  if (!/^\d{9}$/.test(t)) {
    throw new RuleError('VALIDATION', 'מספר הקצאה חייב להיות בדיוק 9 ספרות');
  }
  return t;
}
