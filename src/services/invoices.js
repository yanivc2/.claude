import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

const DOC_TYPES = ['tax_invoice', 'tax_invoice_receipt', 'credit_note'];

/**
 * Record a new invoice (or credit note). Enforces the entry-time control rules:
 *   R2 — duplicate detection (allocation_number is a hard block; supplier+number is a soft warning)
 *   R3 — tax invoice over the allocation threshold with no allocation number => soft block (on_hold)
 *   R4 — same supplier + same total within the duplicate window => soft warning
 *
 * Soft warnings (R2-secondary, R4) are returned to the caller by throwing a RuleError with
 * `meta.warnings` unless `confirm` is true; the UI shows them and the secretary confirms with
 * a reason (§6.4, R4 "נדחית עם סיבה"). Credit notes are stored with negative amounts (§6.6)
 * and are exempt from the allocation requirement (§10.2).
 *
 * @returns {{invoice: object, warnings: Array<{code:string,message:string}>}}
 */
export function createInvoice(input, actor, db = getDb()) {
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

  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(supplierId);
  if (!supplier) throw new NotFoundError(`ספק ${supplierId} לא נמצא`);
  const store = db.prepare('SELECT * FROM stores WHERE id = ?').get(storeId);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);

  const alloc = normalizeAllocation(allocationNumber);

  // Credit notes are stored negative; other docs positive.
  const sign = docType === 'credit_note' ? -1 : 1;
  const beforeVat = sign * Math.abs(amountBeforeVat);
  const vat = sign * Math.abs(vatAmount);
  const total = beforeVat + vat;

  // ---- R2 (primary): allocation number is a strong key — hard block -----------
  if (alloc) {
    const clash = db
      .prepare('SELECT id FROM invoices WHERE allocation_number = ?')
      .get(alloc);
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
  const sameNumber = db
    .prepare('SELECT id FROM invoices WHERE supplier_id = ? AND invoice_number = ?')
    .get(supplierId, String(invoiceNumber).trim());
  if (sameNumber) {
    warnings.push({
      code: 'R2',
      message: `כבר קיימת חשבונית #${sameNumber.id} לספק זה עם מספר ${invoiceNumber} — ודא שאינה כפילות`,
    });
  }

  // R4: same supplier + same total within the duplicate window.
  const dupWindow = db
    .prepare(
      `SELECT id, invoice_date FROM invoices
        WHERE supplier_id = ? AND total_amount = ?
          AND ABS(julianday(invoice_date) - julianday(?)) <= ?`,
    )
    .get(supplierId, total, invoiceDate, config.rules.dupWindowDays);
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

  const info = db
    .prepare(
      `INSERT INTO invoices
         (supplier_id, company_id, store_id, invoice_number, allocation_number,
          invoice_date, amount_before_vat, vat_amount, total_amount, doc_type,
          image_path, status, hold_reason, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
    );

  logAction(
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
    db,
  );

  return { invoice: getInvoice(info.lastInsertRowid, db), warnings };
}

/**
 * Approve an invoice for payment. Enforces:
 *   - a `paid` invoice cannot be re-approved
 *   - an `on_hold` invoice can only be released by the owner (R3 resolution / R6 override)
 *   - re-checks the R3 condition for non-owners
 */
export function approveInvoiceForPayment(id, actor, db = getDb()) {
  const invoice = getInvoice(id, db);
  if (invoice.status === 'paid') {
    throw new RuleError('R', 'חשבונית ששולמה — לא ניתן לאשר מחדש');
  }
  if (invoice.status === 'approved_for_payment') return invoice;

  const r3Blocks =
    invoice.status === 'on_hold' ||
    (invoice.doc_type === 'tax_invoice' &&
      !invoice.allocation_number &&
      Math.abs(invoice.amount_before_vat) > config.rules.allocationThresholdAgorot);

  if (r3Blocks && actor.role !== 'owner') {
    throw new AuthError(
      'חשבונית זו חסומה לתשלום (R3/on_hold). שחרור/עקיפה — בעלים בלבד (R6)',
    );
  }

  db.prepare(
    "UPDATE invoices SET status = 'approved_for_payment', hold_reason = NULL WHERE id = ?",
  ).run(id);

  logAction(
    {
      userId: actor.id,
      action: 'invoice.approve_for_payment',
      entityType: 'invoice',
      entityId: id,
      details: { ownerOverride: r3Blocks && actor.role === 'owner' },
    },
    db,
  );
  return getInvoice(id, db);
}

/** Put an invoice on hold — owner only (R6). */
export function putOnHold(id, reason, actor, db = getDb()) {
  if (actor.role !== 'owner') throw new AuthError('החזקה/שחרור חשבונית — בעלים בלבד (R6)');
  const invoice = getInvoice(id, db);
  if (invoice.status === 'paid') throw new RuleError('R', 'חשבונית ששולמה — לא ניתן להחזיק');
  db.prepare("UPDATE invoices SET status = 'on_hold', hold_reason = ? WHERE id = ?").run(
    reason || 'הוחזק ידנית ע"י בעלים',
    id,
  );
  logAction({ userId: actor.id, action: 'invoice.hold', entityType: 'invoice', entityId: id, details: { reason } }, db);
  return getInvoice(id, db);
}

/**
 * Set/replace the allocation number on an invoice. If this resolves an R3 hold,
 * the invoice returns to `recorded`. Allocation number stays a strong dedup key (R2).
 */
export function setAllocationNumber(id, allocationNumber, actor, db = getDb()) {
  const invoice = getInvoice(id, db);
  const alloc = normalizeAllocation(allocationNumber);
  if (!alloc) throw new RuleError('VALIDATION', 'מספר הקצאה חייב להיות 9 ספרות');

  const clash = db
    .prepare('SELECT id FROM invoices WHERE allocation_number = ? AND id <> ?')
    .get(alloc, id);
  if (clash) {
    throw new RuleError('R2', `מספר הקצאה ${alloc} כבר קיים (חשבונית #${clash.id})`, {
      conflictInvoiceId: clash.id,
    });
  }

  const clearsHold = invoice.status === 'on_hold';
  db.prepare(
    `UPDATE invoices
        SET allocation_number = ?,
            status = CASE WHEN status = 'on_hold' THEN 'recorded' ELSE status END,
            hold_reason = CASE WHEN status = 'on_hold' THEN NULL ELSE hold_reason END
      WHERE id = ?`,
  ).run(alloc, id);

  logAction(
    { userId: actor.id, action: 'invoice.set_allocation', entityType: 'invoice', entityId: id, details: { allocationNumber: alloc, clearsHold } },
    db,
  );
  return getInvoice(id, db);
}

/**
 * Attach or replace the invoice image (stage 1b). Returns the previous image_path
 * (or null) so the caller can delete the now-orphaned file from disk.
 */
export function setImage(id, imagePath, actor, db = getDb()) {
  const invoice = getInvoice(id, db);
  const previous = invoice.image_path;
  db.prepare('UPDATE invoices SET image_path = ? WHERE id = ?').run(imagePath, id);
  logAction(
    { userId: actor.id, action: 'invoice.set_image', entityType: 'invoice', entityId: id, details: { imagePath } },
    db,
  );
  return previous;
}

// ---- reads -------------------------------------------------------------------

export function getInvoice(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`חשבונית ${id} לא נמצאה`);
  return row;
}

/** Invoice with joined supplier / store / company names, for detail views. */
export function getInvoiceDetail(id, db = getDb()) {
  const row = db
    .prepare(
      `SELECT i.*, s.name AS supplier_name, s.status AS supplier_status,
              st.name AS store_name, c.name AS company_name
         FROM invoices i
         JOIN suppliers s ON s.id = i.supplier_id
         JOIN stores st ON st.id = i.store_id
         JOIN companies c ON c.id = i.company_id
        WHERE i.id = ?`,
    )
    .get(id);
  if (!row) throw new NotFoundError(`חשבונית ${id} לא נמצאה`);
  // Which payment (check) paid this invoice, if any.
  row.payment = db
    .prepare(
      `SELECT p.id, p.check_number, p.payment_date, p.status AS payment_status, p.cleared_date
         FROM payment_lines pl JOIN payments p ON p.id = pl.payment_id
        WHERE pl.invoice_id = ?`,
    )
    .get(id);
  return row;
}

/** List invoices with joined names, optional status filter. */
export function listInvoices({ status = null } = {}, db = getDb()) {
  const base = `SELECT i.*, s.name AS supplier_name, s.status AS supplier_status,
                       st.name AS store_name
                  FROM invoices i
                  JOIN suppliers s ON s.id = i.supplier_id
                  JOIN stores st ON st.id = i.store_id`;
  if (status) {
    return db.prepare(`${base} WHERE i.status = ? ORDER BY i.id DESC`).all(status);
  }
  return db.prepare(`${base} ORDER BY i.id DESC`).all();
}

/**
 * Invoices eligible to be applied to a payment: approved_for_payment and not yet paid.
 * Credit notes that are approved_for_payment are included (they reduce the check).
 */
export function listPayable(db = getDb()) {
  return db
    .prepare(
      `SELECT i.*, s.name AS supplier_name, st.name AS store_name, ba.id AS derived_bank_account_id,
              ba.display_name AS bank_account_name
         FROM invoices i
         JOIN suppliers s ON s.id = i.supplier_id
         JOIN stores st ON st.id = i.store_id
         JOIN bank_accounts ba ON ba.store_id = i.store_id
        WHERE i.status = 'approved_for_payment'
        ORDER BY s.name, i.invoice_date`,
    )
    .all();
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
