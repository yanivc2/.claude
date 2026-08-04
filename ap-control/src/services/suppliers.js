import { getExecutor, nowTs } from '../db/adapter.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { userCan } from '../lib/permissions.js';
import { logAction } from './audit.js';

/** List suppliers, optionally filtered by status, ordered by name. */
export async function listSuppliers(status = null, x = getExecutor()) {
  if (status) {
    return x.many('SELECT * FROM suppliers WHERE status = ? ORDER BY name', [status]);
  }
  return x.many('SELECT * FROM suppliers ORDER BY name', []);
}

export async function getSupplier(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM suppliers WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`ספק ${id} לא נמצא`);
  return row;
}

/**
 * Create a supplier. Always starts as `pending` (§6.2) — the secretary may keep
 * recording invoices against it, but payment is blocked until an owner approves (R1/R6).
 */
export async function createSupplier(
  { name, taxId = null, notes = null, phone = null, email = null, contactName = null, contactPhone = null, paymentMethod = null, paymentTerms = null },
  actor,
  x = getExecutor(),
) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new RuleError('VALIDATION', 'שם ספק חובה');

  const info = await x.run(
    `INSERT INTO suppliers (name, tax_id, status, notes, phone, email, contact_name, contact_phone, payment_method, payment_terms)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
    [
      trimmed,
      taxId?.trim() || null,
      notes?.trim() || null,
      phone?.trim() || null,
      email?.trim() || null,
      contactName?.trim() || null,
      contactPhone?.trim() || null,
      paymentMethod?.trim() || null,
      paymentTerms?.trim() || null,
    ],
  );

  await logAction(
    { userId: actor.id, action: 'supplier.create', entityType: 'supplier', entityId: info.lastInsertRowid, details: { name: trimmed } },
    x,
  );
  return getSupplier(info.lastInsertRowid, x);
}

/** Update a supplier's contact details (phone/email/bookkeeping contact). */
export async function updateSupplierContacts(
  id,
  { phone = null, email = null, contactName = null, contactPhone = null },
  actor,
  x = getExecutor(),
) {
  await getSupplier(id, x);
  await x.run(
    'UPDATE suppliers SET phone = ?, email = ?, contact_name = ?, contact_phone = ? WHERE id = ?',
    [
      phone?.trim() || null,
      email?.trim() || null,
      contactName?.trim() || null,
      contactPhone?.trim() || null,
      id,
    ],
  );
  await logAction({ userId: actor.id, action: 'supplier.update_contacts', entityType: 'supplier', entityId: id }, x);
  return getSupplier(id, x);
}

/** Update a supplier's full details (name / tax id / notes / contacts). */
export async function updateSupplier(
  id,
  { name, taxId = null, notes = null, phone = null, email = null, contactName = null, contactPhone = null, paymentMethod = null, paymentTerms = null },
  actor,
  x = getExecutor(),
) {
  await getSupplier(id, x);
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new RuleError('VALIDATION', 'שם ספק חובה');
  await x.run(
    `UPDATE suppliers SET name = ?, tax_id = ?, notes = ?, phone = ?, email = ?, contact_name = ?, contact_phone = ?,
            payment_method = ?, payment_terms = ?
     WHERE id = ?`,
    [
      trimmed,
      taxId?.trim() || null,
      notes?.trim() || null,
      phone?.trim() || null,
      email?.trim() || null,
      contactName?.trim() || null,
      contactPhone?.trim() || null,
      paymentMethod?.trim() || null,
      paymentTerms?.trim() || null,
      id,
    ],
  );
  await logAction({ userId: actor.id, action: 'supplier.update', entityType: 'supplier', entityId: id }, x);
  return getSupplier(id, x);
}

/** Quick supplier search by name / tax id / phone / contact — for the dashboard search box. */
export async function searchSuppliers(query, x = getExecutor()) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;
  return x.many(
    `SELECT * FROM suppliers
      WHERE name LIKE ? OR tax_id LIKE ? OR phone LIKE ? OR contact_name LIKE ? OR contact_phone LIKE ?
      ORDER BY name LIMIT 20`,
    [like, like, like, like, like],
  );
}

/**
 * Approve a supplier — owner only (R6). Records approver + timestamp and audits.
 */
export async function approveSupplier(id, actor, x = getExecutor()) {
  requireOwner(actor);
  const supplier = await getSupplier(id, x);
  if (supplier.status === 'approved') return supplier;

  await x.run(
    `UPDATE suppliers SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?`,
    [actor.id, nowTs(), id],
  );

  await logAction({ userId: actor.id, action: 'supplier.approve', entityType: 'supplier', entityId: id }, x);
  return getSupplier(id, x);
}

/** Block a supplier — owner only (R6). Blocked suppliers can never be paid (R1). */
export async function blockSupplier(id, actor, reason = null, x = getExecutor()) {
  requireOwner(actor);
  await getSupplier(id, x);
  await x.run("UPDATE suppliers SET status = 'blocked' WHERE id = ?", [id]);
  await logAction(
    { userId: actor.id, action: 'supplier.block', entityType: 'supplier', entityId: id, details: { reason } },
    x,
  );
  return getSupplier(id, x);
}

/**
 * Delete a supplier — owner only. Refused if any invoice references it (block it instead, so
 * history is preserved). Intended for cleaning up mistaken/duplicate entries.
 */
export async function deleteSupplier(id, actor, x = getExecutor()) {
  requireOwner(actor);
  await getSupplier(id, x);
  const used = await x.one('SELECT COUNT(*) AS n FROM invoices WHERE supplier_id = ?', [id]);
  if (used.n > 0) {
    throw new RuleError('IN_USE', `לספק זה יש ${used.n} חשבוניות — לא ניתן למחוק. חסום אותו במקום.`);
  }
  await x.run('DELETE FROM suppliers WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'supplier.delete', entityType: 'supplier', entityId: id }, x);
}

function requireOwner(actor) {
  if (!userCan(actor, 'manage_suppliers')) {
    throw new AuthError('אישור/חסימת/מחיקת ספק — נדרשת הרשאת ניהול ספקים (R6)');
  }
}
