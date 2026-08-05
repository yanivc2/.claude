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

export async function deleteDeposit(id, actor, x = getExecutor()) {
  await x.run('DELETE FROM deposits WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'deposit.delete', entityType: 'deposit', entityId: id }, x);
}
