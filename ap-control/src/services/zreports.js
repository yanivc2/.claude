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

// Cash denominations for the deposit calculator (shekel value + a form-safe key).
export const DENOMS = [
  { value: 200, key: '200' }, { value: 100, key: '100' }, { value: 50, key: '50' },
  { value: 20, key: '20' }, { value: 10, key: '10' }, { value: 5, key: '5' },
  { value: 1, key: '1' }, { value: 0.5, key: '0_5' }, { value: 0.1, key: '0_1' },
];

/**
 * Save the deposit for a Z report from bill counts. Amount (agorot) is computed from the
 * denominations so it can't drift from the breakdown.
 * @param {{counts: Record<string|number, number>, bag?: string}} input
 */
export function setDeposit(zReportId, { counts = {}, bag = null }, actor, db = getDb()) {
  getZReport(zReportId, db);
  let amount = 0;
  const clean = {};
  for (const d of DENOMS) {
    const c = Number(counts[d.value] ?? counts[d.key] ?? 0);
    if (!Number.isInteger(c) || c < 0) throw new RuleError('VALIDATION', `כמות שטרות לא תקינה עבור ${d.value}`);
    clean[d.value] = c;
    amount += Math.round(d.value * 100) * c;
  }
  db.prepare('UPDATE z_reports SET deposit_amount = ?, deposit_bag = ?, deposit_breakdown = ? WHERE id = ?')
    .run(amount, bag?.trim() || null, JSON.stringify(clean), zReportId);
  logAction({ userId: actor.id, action: 'zreport.deposit', entityType: 'z_report', entityId: zReportId, details: { amount, bag } }, db);
  return getZReport(zReportId, db);
}

/**
 * Cash reconciliation for a Z report: drawer cash should equal deposit + expenses.
 * @returns {{cash:number, deposit:number, expenses:number, diff:number}}  diff = cash - (deposit+expenses)
 *   diff < 0 => shortage (חוסר), diff > 0 => surplus (יתרה), 0 => match.
 */
export function cashReconciliation(zReportId, db = getDb()) {
  const zr = getZReport(zReportId, db);
  const deposit = zr.deposit_amount || 0;
  const expenses = expensesTotal(zReportId, db);
  const cash = zr.drawer_cash || 0;
  return { cash, deposit, expenses, diff: cash - deposit - expenses };
}

// Credit-card brands for the credit-card report (§ 2d). Each maps to a cc_<key> column.
export const CC_BRANDS = [
  { key: 'kal', label: 'כאל' },
  { key: 'isracard', label: 'ישראכרט' },
  { key: 'diners', label: 'דיינרס' },
  { key: 'amex', label: 'אמקס' },
  { key: 'general', label: 'כללי' },
  { key: 'tourist', label: 'תייר' },
];

/**
 * Save the credit-card report from per-brand amounts. cc_total is computed from the brands.
 * @param {{amounts: Record<string, number>}} input  amounts in agorot
 */
export function setCreditCards(zReportId, { amounts = {} }, actor, db = getDb()) {
  getZReport(zReportId, db);
  let total = 0;
  const v = {};
  for (const b of CC_BRANDS) {
    const a = Number(amounts[b.key] || 0);
    if (!Number.isFinite(a) || a < 0) throw new RuleError('VALIDATION', `סכום אשראי לא תקין עבור ${b.label}`);
    v[b.key] = a;
    total += a;
  }
  db.prepare(
    `UPDATE z_reports SET cc_kal = ?, cc_isracard = ?, cc_diners = ?, cc_amex = ?, cc_general = ?, cc_tourist = ?, cc_total = ?
     WHERE id = ?`,
  ).run(v.kal, v.isracard, v.diners, v.amex, v.general, v.tourist, total, zReportId);
  logAction({ userId: actor.id, action: 'zreport.creditcards', entityType: 'z_report', entityId: zReportId, details: { total } }, db);
  return getZReport(zReportId, db);
}

/**
 * Credit-card reconciliation. The card-brand total normally sits BELOW אשראי מגירה, because
 * customer debts paid by credit inflate אשראי מגירה. The positive gap is shown as "שולם בחוב
 * באשראי" (informational only — not blocking).
 * @returns {{ccTotal:number, drawerCredit:number, debtOnCredit:number}}  debtOnCredit = drawerCredit - ccTotal
 */
export function ccReconciliation(zReportId, db = getDb()) {
  const zr = getZReport(zReportId, db);
  const ccTotal = zr.cc_total || 0;
  const drawerCredit = zr.drawer_credit || 0;
  return { ccTotal, drawerCredit, debtOnCredit: drawerCredit - ccTotal };
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
