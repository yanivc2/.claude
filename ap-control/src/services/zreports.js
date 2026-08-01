import { getExecutor } from '../db/adapter.js';
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
export async function createZReport(input, actor, x = getExecutor()) {
  const {
    storeId, zNumber, zDate, dailyTotal = 0,
    drawerCash = 0, drawerCheck = 0, drawerCredit = 0, drawerHakafa = 0, drawerVouchers = 0,
    notes = null,
  } = input;

  const store = await x.one('SELECT id FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);
  if (!zNumber || !String(zNumber).trim()) throw new RuleError('VALIDATION', 'מספר Z חובה');
  if (!zDate) throw new RuleError('VALIDATION', 'תאריך Z חובה');

  const zNum = String(zNumber).trim();
  const dup = await x.one('SELECT id FROM z_reports WHERE store_id = ? AND z_number = ?', [storeId, zNum]);
  if (dup) throw new RuleError('VALIDATION', `דוח Z מספר ${zNum} כבר קיים לחנות זו`);

  const drawerTotal = drawerCash + drawerCheck + drawerCredit + drawerHakafa + drawerVouchers;
  if (drawerTotal <= 0) throw new RuleError('VALIDATION', 'סה"כ מגירה חובה — הזן לפחות רכיב מגירה אחד.');

  const info = await x.run(
    `INSERT INTO z_reports
       (store_id, z_number, z_date, daily_total, drawer_cash, drawer_check, drawer_credit,
        drawer_hakafa, drawer_vouchers, drawer_total, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [storeId, zNum, zDate, dailyTotal, drawerCash, drawerCheck, drawerCredit, drawerHakafa, drawerVouchers, drawerTotal, actor.id],
  );

  await logAction(
    { userId: actor.id, action: 'zreport.create', entityType: 'z_report', entityId: info.lastInsertRowid, details: { storeId, zNumber: zNum, dailyTotal } },
    x,
  );
  return getZReport(info.lastInsertRowid, x);
}

export async function getZReport(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM z_reports WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`דוח Z ${id} לא נמצא`);
  return row;
}

export async function deleteZReport(id, actor, x = getExecutor()) {
  await getZReport(id, x);
  await x.run('DELETE FROM z_reports WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'zreport.delete', entityType: 'z_report', entityId: id }, x);
}

/** Recent Z reports, newest first, optionally filtered by store. */
export async function listZReports({ storeId = null, limit = 40 } = {}, x = getExecutor()) {
  const base = `SELECT z.*, st.name AS store_name
                  FROM z_reports z JOIN stores st ON st.id = z.store_id`;
  if (storeId) {
    return x.many(`${base} WHERE z.store_id = ? ORDER BY z.z_date DESC, z.id DESC LIMIT ?`, [storeId, limit]);
  }
  return x.many(`${base} ORDER BY z.z_date DESC, z.id DESC LIMIT ?`, [limit]);
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
 */
export async function setDeposit(zReportId, { counts = {}, bag = null }, actor, x = getExecutor()) {
  await getZReport(zReportId, x);
  let amount = 0;
  const clean = {};
  for (const d of DENOMS) {
    const c = Number(counts[d.value] ?? counts[d.key] ?? 0);
    if (!Number.isInteger(c) || c < 0) throw new RuleError('VALIDATION', `כמות שטרות לא תקינה עבור ${d.value}`);
    clean[d.value] = c;
    amount += Math.round(d.value * 100) * c;
  }
  await x.run('UPDATE z_reports SET deposit_amount = ?, deposit_bag = ?, deposit_breakdown = ? WHERE id = ?', [
    amount,
    bag?.trim() || null,
    JSON.stringify(clean),
    zReportId,
  ]);
  await logAction({ userId: actor.id, action: 'zreport.deposit', entityType: 'z_report', entityId: zReportId, details: { amount, bag } }, x);
  return getZReport(zReportId, x);
}

/**
 * Cash reconciliation for a Z report: drawer cash should equal deposit + expenses.
 * @returns {{cash:number, deposit:number, expenses:number, diff:number}}
 */
export async function cashReconciliation(zReportId, x = getExecutor()) {
  const zr = await getZReport(zReportId, x);
  const deposit = zr.deposit_amount || 0;
  const expenses = await expensesTotal(zReportId, x);
  const cash = zr.drawer_cash || 0;
  return { cash, deposit, expenses, diff: cash - deposit - expenses };
}

/**
 * Overall reconciliation status for a Z report — "Z לא תואם" surfacing (§ 2d, option א).
 * @returns {{matched:boolean, issues:Array<{type:string,label:string,diff:number}>, cash:object, cc:object}}
 */
export async function zReconciliationStatus(zReportId, x = getExecutor()) {
  const zr = await getZReport(zReportId, x);
  const cash = await cashReconciliation(zReportId, x);
  const cc = await ccReconciliation(zReportId, x);
  const issues = [];
  if (zr.deposit_amount != null && cash.diff !== 0) {
    issues.push({ type: 'cash', label: cash.diff < 0 ? 'חוסר במזומן' : 'עודף במזומן', diff: cash.diff });
  }
  if (zr.cc_total != null && cc.debtOnCredit < 0) {
    issues.push({ type: 'cc', label: 'מותגי אשראי גבוהים מאשראי מגירה', diff: cc.debtOnCredit });
  }
  return { matched: issues.length === 0, issues, cash, cc };
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
 */
export async function setCreditCards(zReportId, { amounts = {} }, actor, x = getExecutor()) {
  await getZReport(zReportId, x);
  let total = 0;
  const v = {};
  for (const b of CC_BRANDS) {
    const a = Number(amounts[b.key] || 0);
    if (!Number.isFinite(a) || a < 0) throw new RuleError('VALIDATION', `סכום אשראי לא תקין עבור ${b.label}`);
    v[b.key] = a;
    total += a;
  }
  await x.run(
    `UPDATE z_reports SET cc_kal = ?, cc_isracard = ?, cc_diners = ?, cc_amex = ?, cc_general = ?, cc_tourist = ?, cc_total = ?
     WHERE id = ?`,
    [v.kal, v.isracard, v.diners, v.amex, v.general, v.tourist, total, zReportId],
  );
  await logAction({ userId: actor.id, action: 'zreport.creditcards', entityType: 'z_report', entityId: zReportId, details: { total } }, x);
  return getZReport(zReportId, x);
}

/**
 * Credit-card reconciliation. debtOnCredit = drawerCredit - ccTotal (positive = "שולם בחוב באשראי").
 * @returns {{ccTotal:number, drawerCredit:number, debtOnCredit:number}}
 */
export async function ccReconciliation(zReportId, x = getExecutor()) {
  const zr = await getZReport(zReportId, x);
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
export async function addExpense(zReportId, input, actor, x = getExecutor()) {
  await getZReport(zReportId, x);
  const { expenseDate = null, payerName = null, descriptionType = null, employeeName = null, amount = 0, imagePath = null } = input;
  if (!Number.isFinite(amount) || amount < 0) throw new RuleError('VALIDATION', 'סכום הוצאה חייב להיות מספר לא-שלילי');
  const info = await x.run(
    `INSERT INTO z_expenses (z_report_id, expense_date, payer_name, description_type, employee_name, amount, image_path)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [zReportId, expenseDate, payerName?.trim() || null, descriptionType || null, employeeName?.trim() || null, amount, imagePath],
  );
  await logAction({ userId: actor.id, action: 'zexpense.add', entityType: 'z_expense', entityId: info.lastInsertRowid, details: { zReportId, amount } }, x);
  return x.one('SELECT * FROM z_expenses WHERE id = ?', [info.lastInsertRowid]);
}

export async function listExpenses(zReportId, x = getExecutor()) {
  return x.many('SELECT * FROM z_expenses WHERE z_report_id = ? ORDER BY id', [zReportId]);
}

export async function expensesTotal(zReportId, x = getExecutor()) {
  const row = await x.one('SELECT COALESCE(SUM(amount),0) AS s FROM z_expenses WHERE z_report_id = ?', [zReportId]);
  return row.s;
}

export async function getExpense(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM z_expenses WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`הוצאה ${id} לא נמצאה`);
  return row;
}

export async function deleteExpense(id, actor, x = getExecutor()) {
  const row = await getExpense(id, x);
  await x.run('DELETE FROM z_expenses WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'zexpense.delete', entityType: 'z_expense', entityId: id }, x);
  return row;
}

/**
 * Detect gaps in the Z-number sequence for a store (numeric Z numbers only).
 * @returns {number[]} the missing Z numbers between the min and max recorded
 */
export async function missingZNumbers(storeId, x = getExecutor()) {
  const rows = await x.many('SELECT z_number FROM z_reports WHERE store_id = ?', [storeId]);
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
