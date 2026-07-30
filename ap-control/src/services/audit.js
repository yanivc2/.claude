import { getDb } from '../db/index.js';

/**
 * Append an entry to the audit log (§4 audit_log). Every state-changing action
 * (supplier approval, invoice entry/approval, payment issuance, clearing) records one.
 *
 * @param {object} params
 * @param {number|null} params.userId  Acting user id
 * @param {string} params.action  e.g. 'supplier.approve', 'invoice.create'
 * @param {string} params.entityType  e.g. 'supplier', 'invoice', 'payment'
 * @param {number} [params.entityId]
 * @param {object|string} [params.details]  Serialized to JSON if an object
 * @param {import('better-sqlite3').Database} [db]
 */
export function logAction(
  { userId, action, entityType, entityId = null, details = null },
  db = getDb(),
) {
  const detailsText =
    details && typeof details === 'object' ? JSON.stringify(details) : details;
  db.prepare(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(userId ?? null, action, entityType, entityId, detailsText);
}

/** Recent audit entries, newest first, with the acting user's name joined in. */
export function listRecent(limit = 100, db = getDb()) {
  return db
    .prepare(
      `SELECT a.*, u.name AS user_name
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC
        LIMIT ?`,
    )
    .all(limit);
}
