import { getExecutor } from '../db/adapter.js';
import { NotFoundError } from './errors.js';

// Separation guard for direct-by-id access (company AND store). The list endpoints filter by
// req.scope, but fetching/acting on a single entity by id (e.g. /invoices/57, /payments/40/print)
// bypassed that — a non-owner could read or act on another company's (or, with per-store grants,
// another store's) record by changing the id in the URL (IDOR). These guards resolve the owning
// company_id + store_id for an entity and refuse (404, so existence isn't leaked) when it falls
// outside the caller's authorized companies or stores. Owner scope (null) is always allowed.

// One query per kind → { company_id, store_id }. Every guarded kind is store-bound.
const SCOPE_OF = {
  invoice: 'SELECT company_id, store_id FROM invoices WHERE id = ?',
  payment:
    'SELECT ba.company_id AS company_id, ba.store_id AS store_id FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id WHERE p.id = ?',
  zreport: 'SELECT st.company_id AS company_id, z.store_id AS store_id FROM z_reports z JOIN stores st ON st.id = z.store_id WHERE z.id = ?',
  deposit: 'SELECT st.company_id AS company_id, d.store_id AS store_id FROM deposits d JOIN stores st ON st.id = d.store_id WHERE d.id = ?',
  expense:
    'SELECT st.company_id AS company_id, z.store_id AS store_id FROM z_expenses e JOIN z_reports z ON z.id = e.z_report_id JOIN stores st ON st.id = z.store_id WHERE e.id = ?',
  scanDraft: 'SELECT company_id, store_id FROM invoice_drafts WHERE id = ?',
  bankAccount: 'SELECT company_id, store_id FROM bank_accounts WHERE id = ?',
  bankTxn:
    'SELECT ba.company_id AS company_id, ba.store_id AS store_id FROM bank_transactions bt JOIN bank_accounts ba ON ba.id = bt.bank_account_id WHERE bt.id = ?',
};

// Accept the historical shape (companyIds array / null) as well as the full req.scope object
// { companyIds, storeIds }. Array/null → company-only check (back-compat with direct callers/tests).
function normalizeScope(scope) {
  if (scope == null) return { companyIds: null, storeIds: null };
  if (Array.isArray(scope)) return { companyIds: scope, storeIds: null };
  return { companyIds: scope.companyIds ?? null, storeIds: scope.storeIds ?? null };
}

/**
 * Throw NotFoundError if entity <kind:id> is missing OR outside the caller's company/store scope.
 * @param {'invoice'|'payment'|'zreport'|'deposit'|'expense'|'scanDraft'|'bankAccount'|'bankTxn'} kind
 * @param {number|string} id
 * @param {number[]|null|{companyIds:number[]|null, storeIds:number[]|null}} scope
 * @returns {Promise<number>} the entity's company_id (when in scope)
 */
export async function assertInScope(kind, id, scope, x = getExecutor()) {
  const sql = SCOPE_OF[kind];
  if (!sql) throw new Error(`assertInScope: unknown kind "${kind}"`);
  const { companyIds, storeIds } = normalizeScope(scope);
  const nid = Number(id);
  const row = Number.isInteger(nid) ? await x.one(sql, [nid]) : null;
  const companyOk = !row ? false : companyIds == null || companyIds.includes(Number(row.company_id));
  // Store check only bites when the caller is store-scoped AND the entity is bound to a store —
  // a store-less row (null store_id) isn't store-bound, so it stays visible within the company.
  const storeOk =
    !row ? false : storeIds == null || row.store_id == null || storeIds.includes(Number(row.store_id));
  if (!row || !companyOk || !storeOk) {
    throw new NotFoundError('הרשומה לא נמצאה');
  }
  return Number(row.company_id);
}

/**
 * Express guard (usable as router.param('id', …) or router.use('/prefix/:id', …)) that enforces
 * company + store scope on every id-bearing route for one entity kind. Reads req.params.id + req.scope.
 */
export function scopeParam(kind) {
  return async (req, res, next) => {
    try {
      await assertInScope(kind, req.params.id, req.scope);
      next();
    } catch (err) {
      next(err);
    }
  };
}
