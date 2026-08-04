import { getExecutor } from '../db/adapter.js';
import { NotFoundError } from './errors.js';

// Company-separation guard for direct-by-id access. The list endpoints already filter by
// req.scope.companyIds, but fetching/acting on a single entity by id (e.g. /invoices/57,
// /payments/40/print, /invoices/57/image) bypassed that — a non-owner could read or act on
// another company's records by changing the id in the URL (cross-company IDOR). These guards
// resolve the owning company_id for an entity and refuse (404, so existence isn't leaked)
// when it falls outside the caller's authorized companies. Owners have scope = null → allowed.

const COMPANY_OF = {
  invoice: 'SELECT company_id FROM invoices WHERE id = ?',
  payment:
    'SELECT ba.company_id AS company_id FROM payments p JOIN bank_accounts ba ON ba.id = p.bank_account_id WHERE p.id = ?',
  zreport: 'SELECT st.company_id AS company_id FROM z_reports z JOIN stores st ON st.id = z.store_id WHERE z.id = ?',
  deposit: 'SELECT st.company_id AS company_id FROM deposits d JOIN stores st ON st.id = d.store_id WHERE d.id = ?',
  expense:
    'SELECT st.company_id AS company_id FROM z_expenses e JOIN z_reports z ON z.id = e.z_report_id JOIN stores st ON st.id = z.store_id WHERE e.id = ?',
};

/**
 * Throw NotFoundError if entity <kind:id> is missing OR outside the caller's company scope.
 * @param {'invoice'|'payment'|'zreport'|'deposit'|'expense'} kind
 * @param {number|string} id
 * @param {number[]|null} scope  companyIds (null = owner / all)
 * @returns {Promise<number>} the entity's company_id (when in scope)
 */
export async function assertInScope(kind, id, scope, x = getExecutor()) {
  const sql = COMPANY_OF[kind];
  if (!sql) throw new Error(`assertInScope: unknown kind "${kind}"`);
  const nid = Number(id);
  const row = Number.isInteger(nid) ? await x.one(sql, [nid]) : null;
  if (!row || (scope != null && !scope.includes(Number(row.company_id)))) {
    throw new NotFoundError('הרשומה לא נמצאה');
  }
  return Number(row.company_id);
}

/**
 * Express guard (usable as router.param('id', …) or router.use('/prefix/:id', …)) that enforces
 * company scope on every id-bearing route for one entity kind. Reads req.params.id + req.scope.
 */
export function scopeParam(kind) {
  return async (req, res, next) => {
    try {
      await assertInScope(kind, req.params.id, req.scope?.companyIds);
      next();
    } catch (err) {
      next(err);
    }
  };
}
