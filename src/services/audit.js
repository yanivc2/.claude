import { getExecutor } from '../db/adapter.js';
import { normalizeScope } from '../lib/scope.js';

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
 * @param {import('../db/adapter.js').Executor} [x]
 */
export async function logAction(
  { userId, action, entityType, entityId = null, details = null },
  x = getExecutor(),
) {
  const detailsText =
    details && typeof details === 'object' ? JSON.stringify(details) : details;
  await x.run(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, details)
     VALUES (?, ?, ?, ?, ?)`,
    [userId ?? null, action, entityType, entityId, detailsText],
  );
}

// Which entities an audit entry can be traced back to a company/store through. An entry whose
// entity_type isn't here cannot be attributed to a company (org-level rows like user/company/
// role_template, or global ones like supplier), so it is hidden from anyone but the owner.
const AUDIT_SCOPE_SQL = {
  invoice: 'SELECT id, company_id, store_id FROM invoices WHERE id IN (:ids)',
  payment:
    'SELECT p.id AS id, ba.company_id AS company_id, ba.store_id AS store_id FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id WHERE p.id IN (:ids)',
  bank_account: 'SELECT id, company_id, store_id FROM bank_accounts WHERE id IN (:ids)',
  bank_transaction:
    'SELECT bt.id AS id, ba.company_id AS company_id, ba.store_id AS store_id FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id WHERE bt.id IN (:ids)',
  store: 'SELECT id, company_id, id AS store_id FROM stores WHERE id IN (:ids)',
  z_report:
    'SELECT z.id AS id, st.company_id AS company_id, z.store_id AS store_id FROM z_reports z JOIN stores st ON st.id = z.store_id WHERE z.id IN (:ids)',
  z_closing:
    'SELECT zc.id AS id, st.company_id AS company_id, zc.store_id AS store_id FROM z_closings zc JOIN stores st ON st.id = zc.store_id WHERE zc.id IN (:ids)',
  deposit:
    'SELECT d.id AS id, st.company_id AS company_id, d.store_id AS store_id FROM deposits d JOIN stores st ON st.id = d.store_id WHERE d.id IN (:ids)',
  invoice_draft: 'SELECT id, company_id, store_id FROM invoice_drafts WHERE id IN (:ids)',
};

/**
 * Recent audit entries, newest first, with the acting user's name joined in.
 *
 * SCOPED: the audit trail names checks, invoice numbers and amounts, so an unscoped list handed a
 * company-restricted user the other companies' activity. The owner still sees everything; for
 * anyone else an entry is kept only when its entity resolves INSIDE their company/store scope —
 * and an entry that cannot be attributed to a company at all (user/company/supplier/system rows)
 * is withheld rather than guessed at.
 *
 * Resolution is batched (one query per entity type over the page), not per row.
 */
export async function listRecent(limit = 100, scope = null, x = getExecutor()) {
  const rows = await x.many(
    `SELECT a.*, u.name AS user_name
       FROM audit_log a
       LEFT JOIN users u ON u.id = a.user_id
      ORDER BY a.id DESC
      LIMIT ?`,
    [limit],
  );

  const { companyIds, storeIds } = normalizeScope(scope);
  if (companyIds == null && storeIds == null) return rows; // owner

  // Batch-resolve the ids of each scopeable entity type that appears on this page.
  const idsByType = new Map();
  for (const r of rows) {
    const t = r.entity_type;
    if (!AUDIT_SCOPE_SQL[t] || r.entity_id == null) continue;
    if (!idsByType.has(t)) idsByType.set(t, new Set());
    idsByType.get(t).add(Number(r.entity_id));
  }

  const allowed = new Map(); // `${type}:${id}` → true
  for (const [type, idSet] of idsByType) {
    const ids = [...idSet];
    const sql = AUDIT_SCOPE_SQL[type].replace(':ids', ids.map(() => '?').join(','));
    for (const e of await x.many(sql, ids)) {
      const companyOk = companyIds == null || companyIds.includes(Number(e.company_id));
      const storeOk = storeIds == null || e.store_id == null || storeIds.includes(Number(e.store_id));
      if (companyOk && storeOk) allowed.set(`${type}:${Number(e.id)}`, true);
    }
  }

  return rows.filter((r) => allowed.has(`${r.entity_type}:${Number(r.entity_id)}`));
}
