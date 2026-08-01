import { getDb } from '../db/index.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { logAction } from './audit.js';

// Daily register (Z) close (priority 2). daily_total ("יומי Z") feeds the profitability report;
// the drawer breakdown (cash/check/credit/hakafa/vouchers) sums to drawer_total ("סה"כ מגירה").

/**
 * Create a Z report.
 * @param {{storeId:number, zNumber:string, zDate:string, dailyTotal:number,
 *   drawerCash?:number, drawerCheck?:number, drawerCredit?:number,
 *   drawerHakafa?:number, drawerVouchers?:number, notes?:string}} input  amounts in agorot
 */
export function createZReport(input, actor, db = getDb()) {
  const {
    storeId, zNumber, zDate, dailyTotal = 0,
    drawerCash = 0, drawerCheck = 0, drawerCredit = 0, drawerHakafa = 0, drawerVouchers = 0,
    notes = null,
  } = input;

  const store = db.prepare('SELECT id FROM stores WHERE id = ?').get(storeId);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);
  if (!zNumber || !String(zNumber).trim()) throw new RuleError('VALIDATION', 'מספר Z חובה');
  if (!zDate) throw new RuleError('VALIDATION', 'תאריך Z חובה');

  const zNum = String(zNumber).trim();
  const dup = db.prepare('SELECT id FROM z_reports WHERE store_id = ? AND z_number = ?').get(storeId, zNum);
  if (dup) throw new RuleError('VALIDATION', `דוח Z מספר ${zNum} כבר קיים לחנות זו`);

  const drawerTotal = drawerCash + drawerCheck + drawerCredit + drawerHakafa + drawerVouchers;

  const info = db
    .prepare(
      `INSERT INTO z_reports
         (store_id, z_number, z_date, daily_total, drawer_cash, drawer_check, drawer_credit,
          drawer_hakafa, drawer_vouchers, drawer_total, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(storeId, zNum, zDate, dailyTotal, drawerCash, drawerCheck, drawerCredit, drawerHakafa, drawerVouchers, drawerTotal, actor.id);

  logAction(
    { userId: actor.id, action: 'zreport.create', entityType: 'z_report', entityId: info.lastInsertRowid, details: { storeId, zNumber: zNum, dailyTotal } },
    db,
  );
  return getZReport(info.lastInsertRowid, db);
}

export function getZReport(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM z_reports WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`דוח Z ${id} לא נמצא`);
  return row;
}

export function deleteZReport(id, actor, db = getDb()) {
  getZReport(id, db);
  db.prepare('DELETE FROM z_reports WHERE id = ?').run(id);
  logAction({ userId: actor.id, action: 'zreport.delete', entityType: 'z_report', entityId: id }, db);
}

/** Recent Z reports, newest first, optionally filtered by store. */
export function listZReports({ storeId = null, limit = 40 } = {}, db = getDb()) {
  const base = `SELECT z.*, st.name AS store_name
                  FROM z_reports z JOIN stores st ON st.id = z.store_id`;
  if (storeId) {
    return db.prepare(`${base} WHERE z.store_id = ? ORDER BY z.z_date DESC, z.id DESC LIMIT ?`).all(storeId, limit);
  }
  return db.prepare(`${base} ORDER BY z.z_date DESC, z.id DESC LIMIT ?`).all(limit);
}

/**
 * Detect gaps in the Z-number sequence for a store (numeric Z numbers only).
 * @returns {number[]} the missing Z numbers between the min and max recorded
 */
export function missingZNumbers(storeId, db = getDb()) {
  const rows = db.prepare('SELECT z_number FROM z_reports WHERE store_id = ?').all(storeId);
  const nums = rows
    .map((r) => Number(String(r.z_number).trim()))
    .filter((n) => Number.isInteger(n))
    .sort((a, b) => a - b);
  if (nums.length < 2) return [];
  const present = new Set(nums);
  const missing = [];
  for (let n = nums[0] + 1; n < nums[nums.length - 1]; n += 1) {
    if (!present.has(n)) missing.push(n);
  }
  return missing;
}
