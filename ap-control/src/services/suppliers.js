import { getDb } from '../db/index.js';
import { AuthError, NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

/** List suppliers, optionally filtered by status, ordered by name. */
export function listSuppliers(status = null, db = getDb()) {
  if (status) {
    return db
      .prepare('SELECT * FROM suppliers WHERE status = ? ORDER BY name')
      .all(status);
  }
  return db.prepare('SELECT * FROM suppliers ORDER BY name').all();
}

export function getSupplier(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`ספק ${id} לא נמצא`);
  return row;
}

/**
 * Create a supplier. Always starts as `pending` (§6.2) — the secretary may keep
 * recording invoices against it, but payment is blocked until an owner approves (R1/R6).
 */
export function createSupplier(
  { name, taxId = null, notes = null, phone = null, email = null, contactName = null, contactPhone = null },
  actor,
  db = getDb(),
) {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new RuleError('VALIDATION', 'שם ספק חובה');

  const info = db
    .prepare(
      `INSERT INTO suppliers (name, tax_id, status, notes, phone, email, contact_name, contact_phone)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      trimmed,
      taxId?.trim() || null,
      notes?.trim() || null,
      phone?.trim() || null,
      email?.trim() || null,
      contactName?.trim() || null,
      contactPhone?.trim() || null,
    );

  logAction(
    { userId: actor.id, action: 'supplier.create', entityType: 'supplier', entityId: info.lastInsertRowid, details: { name: trimmed } },
    db,
  );
  return getSupplier(info.lastInsertRowid, db);
}

/** Update a supplier's contact details (phone/email/bookkeeping contact). */
export function updateSupplierContacts(
  id,
  { phone = null, email = null, contactName = null, contactPhone = null },
  actor,
  db = getDb(),
) {
  getSupplier(id, db);
  db.prepare(
    'UPDATE suppliers SET phone = ?, email = ?, contact_name = ?, contact_phone = ? WHERE id = ?',
  ).run(
    phone?.trim() || null,
    email?.trim() || null,
    contactName?.trim() || null,
    contactPhone?.trim() || null,
    id,
  );
  logAction({ userId: actor.id, action: 'supplier.update_contacts', entityType: 'supplier', entityId: id }, db);
  return getSupplier(id, db);
}

/** Quick supplier search by name / tax id / phone / contact — for the dashboard search box. */
export function searchSuppliers(query, db = getDb()) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;
  return db
    .prepare(
      `SELECT * FROM suppliers
        WHERE name LIKE ? OR tax_id LIKE ? OR phone LIKE ? OR contact_name LIKE ? OR contact_phone LIKE ?
        ORDER BY name LIMIT 20`,
    )
    .all(like, like, like, like, like);
}

/**
 * Approve a supplier — owner only (R6). Records approver + timestamp and audits.
 */
export function approveSupplier(id, actor, db = getDb()) {
  requireOwner(actor);
  const supplier = getSupplier(id, db);
  if (supplier.status === 'approved') return supplier;

  db.prepare(
    `UPDATE suppliers
        SET status = 'approved', approved_by = ?, approved_at = strftime('%Y-%m-%d %H:%M:%S','now')
      WHERE id = ?`,
  ).run(actor.id, id);

  logAction({ userId: actor.id, action: 'supplier.approve', entityType: 'supplier', entityId: id }, db);
  return getSupplier(id, db);
}

/** Block a supplier — owner only (R6). Blocked suppliers can never be paid (R1). */
export function blockSupplier(id, actor, reason = null, db = getDb()) {
  requireOwner(actor);
  getSupplier(id, db);
  db.prepare("UPDATE suppliers SET status = 'blocked' WHERE id = ?").run(id);
  logAction(
    { userId: actor.id, action: 'supplier.block', entityType: 'supplier', entityId: id, details: { reason } },
    db,
  );
  return getSupplier(id, db);
}

function requireOwner(actor) {
  if (!actor || actor.role !== 'owner') {
    throw new AuthError('אישור/חסימת ספק — פעולת בעלים בלבד (R6)');
  }
}
