import { getExecutor, nowTs } from '../db/adapter.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
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
  { name, taxId = null, notes = null, phone = null, email = null, contactName = null, contactPhone = null },
  actor,
  x = getExecutor(),
) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new RuleError('VALIDATION', 'שם ספק חובה');

  const info = await x.run(
    `INSERT INTO suppliers (name, tax_id, status, notes, phone, email, contact_name, contact_phone)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      trimmed,
      taxId?.trim() || null,
      notes?.trim() || null,
      phone?.trim() || null,
      email?.trim() || null,
      contactName?.trim() || null,
      contactPhone?.trim() || null,
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

function requireOwner(actor) {
  if (!actor || actor.role !== 'owner') {
    throw new AuthError('אישור/חסימת ספק — פעולת בעלים בלבד (R6)');
  }
}
