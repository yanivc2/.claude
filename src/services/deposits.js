import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeClause } from '../lib/scope.js';
import { logAction } from './audit.js';

// "הצהרה על הפקדה" — a bank deposit declaration: a bag number + amount for a store, with a flag
// recording whether it was actually deposited to the bank. Optionally linked to the Z report it
// was declared on (z_report_id) and, after bank reconciliation, to a bank line (bag=reference).

export async function createDeposit(
  { storeId, zReportId = null, depositDate, bagNumber = null, amount = 0, deposited = false },
  actor,
  x = getExecutor(),
) {
  if (!storeId) throw new RuleError('VALIDATION', 'חנות חובה');
  if (!depositDate) throw new RuleError('VALIDATION', 'תאריך הפקדה חובה');
  const info = await x.run(
    'INSERT INTO deposits (store_id, z_report_id, deposit_date, bag_number, amount, deposited, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [Number(storeId), zReportId ? Number(zReportId) : null, depositDate, (bagNumber && String(bagNumber).trim()) || null, amount, deposited ? 1 : 0, actor.id],
  );
  await logAction(
    { userId: actor.id, action: 'deposit.create', entityType: 'deposit', entityId: info.lastInsertRowid, details: { amount, deposited: !!deposited } },
    x,
  );
  return info.lastInsertRowid;
}

// Common SELECT: deposit + store/company names + the linked Z number (for "שיוך ל-Z").
const DEPOSIT_SELECT = `SELECT d.*, st.name AS store_name, c.name AS company_name, z.z_number
                  FROM deposits d
                  JOIN stores st ON st.id = d.store_id
                  JOIN companies c ON c.id = st.company_id
                  LEFT JOIN z_reports z ON z.id = d.z_report_id`;

export async function listDeposits({ storeId = null, scope = null, limit = 30 } = {}, x = getExecutor()) {
  const sc = scopeClause(scope, 'st.company_id');
  const params = [...sc.params];
  let sql = `${DEPOSIT_SELECT} WHERE 1 = 1${sc.sql}`;
  if (storeId) { sql += ' AND d.store_id = ?'; params.push(storeId); }
  sql += ' ORDER BY d.deposit_date DESC, d.id DESC LIMIT ?';
  params.push(limit);
  return x.many(sql, params);
}

/**
 * Create-or-update the deposit declaration linked to a Z report (used by the Z edit form).
 * With nothing declared (no bag and no amount) it's a no-op. Preserves any bank-reconciliation
 * fields on an existing row (only bag/amount/deposited/date are touched).
 */
export async function upsertDepositForZ(zReportId, { storeId, depositDate, bagNumber = null, amount = 0, deposited = false }, actor, x = getExecutor()) {
  const bag = (bagNumber && String(bagNumber).trim()) || null;
  const existing = await x.one('SELECT id FROM deposits WHERE z_report_id = ? ORDER BY id LIMIT 1', [zReportId]);
  if (!bag && !amount) return existing ? existing.id : null; // nothing declared
  if (existing) {
    await x.run(
      'UPDATE deposits SET store_id = ?, deposit_date = ?, bag_number = ?, amount = ?, deposited = ? WHERE id = ?',
      [Number(storeId), depositDate, bag, amount, deposited ? 1 : 0, existing.id],
    );
    await logAction({ userId: actor.id, action: 'deposit.update', entityType: 'deposit', entityId: existing.id, details: { amount } }, x);
    return existing.id;
  }
  return createDeposit({ storeId, zReportId, depositDate, bagNumber: bag, amount, deposited }, actor, x);
}

/** The (first) deposit declaration linked to a Z report, or null. */
export async function depositForZ(zReportId, x = getExecutor()) {
  return x.one('SELECT * FROM deposits WHERE z_report_id = ? ORDER BY id LIMIT 1', [zReportId]);
}

/** Total declared deposit (agorot) linked to a given Z report. */
export async function depositTotalForZ(zReportId, x = getExecutor()) {
  const row = await x.one('SELECT COALESCE(SUM(amount),0) AS s FROM deposits WHERE z_report_id = ?', [zReportId]);
  return Number(row.s) || 0;
}

export async function setDeposited(id, deposited, actor, x = getExecutor()) {
  const row = await x.one('SELECT id FROM deposits WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`הפקדה ${id} לא נמצאה`);
  await x.run('UPDATE deposits SET deposited = ? WHERE id = ?', [deposited ? 1 : 0, id]);
  await logAction({ userId: actor.id, action: 'deposit.mark', entityType: 'deposit', entityId: id, details: { deposited: !!deposited } }, x);
}

/** Set the bag number on a deposit (used by the barcode scanner before marking it deposited). */
export async function setDepositBag(id, bagNumber, actor, x = getExecutor()) {
  const bag = (bagNumber && String(bagNumber).trim()) || null;
  await x.run('UPDATE deposits SET bag_number = ? WHERE id = ?', [bag, id]);
  await logAction({ userId: actor.id, action: 'deposit.bag', entityType: 'deposit', entityId: id, details: { bagNumber: bag } }, x);
}

/**
 * Lifecycle status of a deposit declaration, derived from existing columns (no schema change):
 *   • matched_txn_id set → 'matched'   (הותאמה בבנק)
 *   • deposited = 1      → 'deposited' (הופקדה)
 *   • otherwise          → 'declared'  (הונפקה)
 */
export function depositStatus(d) {
  if (!d) return null;
  if (d.matched_txn_id != null) return { key: 'matched', label: 'הותאמה בבנק', badge: 'b-cleared' };
  if (Number(d.deposited) === 1) return { key: 'deposited', label: 'הופקדה', badge: 'b-approved' };
  return { key: 'declared', label: 'הונפקה', badge: 'b-on_hold' };
}

/** Deposits that were declared but not yet marked deposited (deposited = 0). Newest first. */
export async function declaredNotDeposited({ scope = null, storeId = null } = {}, x = getExecutor()) {
  const sc = scopeClause(scope, 'st.company_id');
  const params = [...sc.params];
  let sql = `${DEPOSIT_SELECT} WHERE d.deposited = 0${sc.sql}`;
  if (storeId) { sql += ' AND d.store_id = ?'; params.push(storeId); }
  sql += ' ORDER BY d.deposit_date DESC, d.id DESC';
  return x.many(sql, params);
}

/** Z reports that have no deposit declaration linked to them yet. Newest first. */
export async function zReportsWithoutDeposit({ scope = null, storeId = null } = {}, x = getExecutor()) {
  const sc = scopeClause(scope, 'st.company_id');
  const params = [...sc.params];
  // NOT IN (non-correlated) keeps pg-mem happy — it rejects correlated subqueries / anti-joins.
  let sql = `SELECT z.id, z.z_number, z.z_date, z.store_id, st.name AS store_name, c.name AS company_name
               FROM z_reports z
               JOIN stores st ON st.id = z.store_id
               JOIN companies c ON c.id = st.company_id
              WHERE z.id NOT IN (SELECT z_report_id FROM deposits WHERE z_report_id IS NOT NULL)${sc.sql}`;
  if (storeId) { sql += ' AND z.store_id = ?'; params.push(storeId); }
  sql += ' ORDER BY z.z_date DESC, z.id DESC';
  return x.many(sql, params);
}

export async function deleteDeposit(id, actor, x = getExecutor()) {
  await x.run('DELETE FROM deposits WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'deposit.delete', entityType: 'deposit', entityId: id }, x);
}
