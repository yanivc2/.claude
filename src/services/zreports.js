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

// Expense description types (§ drawer expenses). Some require an employee name.
export const EXPENSE_TYPES = [
  { value: 'tara', label: 'טרה', needsEmployee: false },
  { value: 'salary_check_split', label: 'פריטת צ׳ק שכר', needsEmployee: true },
  { value: 'advance', label: 'מפרעה', needsEmployee: true },
  { value: 'office_supplies', label: 'ציוד משרדי', needsEmployee: false },
  { value: 'change', label: 'פריטה', needsEmployee: false },
  { value: 'salary_topup', label: 'השלמת שכר', needsEmployee: true },
];

/** Add a drawer-expense line to a Z report. amount in agorot. */
export function addExpense(zReportId, input, actor, db = getDb()) {
  getZReport(zReportId, db);
  const { expenseDate = null, payerName = null, descriptionType = null, employeeName = null, amount = 0, imagePath = null } = input;
  if (!Number.isFinite(amount) || amount < 0) throw new RuleError('VALIDATION', 'סכום הוצאה חייב להיות מספר לא-שלילי');
  const info = db
    .prepare(
      `INSERT INTO z_expenses (z_report_id, expense_date, payer_name, description_type, employee_name, amount, image_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(zReportId, expenseDate, payerName?.trim() || null, descriptionType || null, employeeName?.trim() || null, amount, imagePath);
  logAction({ userId: actor.id, action: 'zexpense.add', entityType: 'z_expense', entityId: info.lastInsertRowid, details: { zReportId, amount } }, db);
  return db.prepare('SELECT * FROM z_expenses WHERE id = ?').get(info.lastInsertRowid);
}

export function listExpenses(zReportId, db = getDb()) {
  return db.prepare('SELECT * FROM z_expenses WHERE z_report_id = ? ORDER BY id').all(zReportId);
}

export function expensesTotal(zReportId, db = getDb()) {
  return db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM z_expenses WHERE z_report_id = ?').get(zReportId).s;
}

export function getExpense(id, db = getDb()) {
  const row = db.prepare('SELECT * FROM z_expenses WHERE id = ?').get(id);
  if (!row) throw new NotFoundError(`הוצאה ${id} לא נמצאה`);
  return row;
}

export function deleteExpense(id, actor, db = getDb()) {
  const row = getExpense(id, db);
  db.prepare('DELETE FROM z_expenses WHERE id = ?').run(id);
  logAction({ userId: actor.id, action: 'zexpense.delete', entityType: 'z_expense', entityId: id }, db);
  return row;
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
