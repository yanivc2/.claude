import { getExecutor, tx } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeClause, scopeWhere, normalizeScope } from '../lib/scope.js';
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

/**
 * Update a Z report's core + drawer fields (edit page). Recomputes drawer_total, stamps
 * updated_at (UTC 'YYYY-MM-DD HH:MM:SS', matching created_at). Same validation as create.
 */
export async function updateZReport(id, input, actor, x = getExecutor()) {
  await getZReport(id, x);
  const {
    storeId, zNumber, zDate, dailyTotal = 0,
    drawerCash = 0, drawerCheck = 0, drawerCredit = 0, drawerHakafa = 0, drawerVouchers = 0,
  } = input;
  const store = await x.one('SELECT id FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new NotFoundError(`חנות ${storeId} לא נמצאה`);
  if (!zNumber || !String(zNumber).trim()) throw new RuleError('VALIDATION', 'מספר Z חובה');
  if (!zDate) throw new RuleError('VALIDATION', 'תאריך Z חובה');
  const zNum = String(zNumber).trim();
  const dup = await x.one('SELECT id FROM z_reports WHERE store_id = ? AND z_number = ? AND id <> ?', [storeId, zNum, id]);
  if (dup) throw new RuleError('VALIDATION', `דוח Z מספר ${zNum} כבר קיים לחנות זו`);
  const drawerTotal = drawerCash + drawerCheck + drawerCredit + drawerHakafa + drawerVouchers;
  if (drawerTotal <= 0) throw new RuleError('VALIDATION', 'סה"כ מגירה חובה — הזן לפחות רכיב מגירה אחד.');
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await x.run(
    `UPDATE z_reports SET store_id = ?, z_number = ?, z_date = ?, daily_total = ?, drawer_cash = ?,
       drawer_check = ?, drawer_credit = ?, drawer_hakafa = ?, drawer_vouchers = ?, drawer_total = ?, updated_at = ?
     WHERE id = ?`,
    [storeId, zNum, zDate, dailyTotal, drawerCash, drawerCheck, drawerCredit, drawerHakafa, drawerVouchers, drawerTotal, now, id],
  );
  await logAction({ userId: actor.id, action: 'zreport.update', entityType: 'z_report', entityId: id, details: { zNumber: zNum } }, x);
  return getZReport(id, x);
}

export async function deleteZReport(id, actor, x = getExecutor()) {
  await getZReport(id, x);
  await x.run('DELETE FROM z_reports WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'zreport.delete', entityType: 'z_report', entityId: id }, x);
}

/** Recent Z reports, newest first, optionally filtered by store. */
export async function listZReports({ storeId = null, limit = 40, scope = null } = {}, x = getExecutor()) {
  // Scoped: a Z report is a store's daily takings. Unscoped, this listed every company's.
  const sc = scopeWhere(scope, 'st.company_id', 'z.store_id');
  const where = [];
  const params = [];
  if (storeId) {
    where.push('z.store_id = ?');
    params.push(storeId);
  }
  const sql = `SELECT z.*, st.name AS store_name
                 FROM z_reports z JOIN stores st ON st.id = z.store_id
                WHERE 1 = 1${where.length ? ` AND ${where.join(' AND ')}` : ''}${sc.sql}
                ORDER BY z.z_date DESC, z.id DESC LIMIT ?`;
  return x.many(sql, [...params, ...sc.params, limit]);
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
// Order is the owner's reporting order — the view renders CC_BRANDS as-is, so this list IS the
// on-screen order. Adding a brand needs a matching cc_<key> column (schema ×3 + migrate).
export const CC_BRANDS = [
  { key: 'isracard', label: 'ישראכרט' },
  { key: 'kal', label: 'כ.א.ל' },
  { key: 'diners', label: 'דיינרס' },
  { key: 'amex', label: 'אמ. אקס' },
  { key: 'leumi', label: 'לאומיק.' },
  { key: 'tourist', label: 'כרטיס תייר' },
  { key: 'general', label: 'כללי' },
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
    `UPDATE z_reports SET cc_kal = ?, cc_isracard = ?, cc_diners = ?, cc_amex = ?, cc_leumi = ?, cc_general = ?, cc_tourist = ?, cc_total = ?
     WHERE id = ?`,
    [v.kal, v.isracard, v.diners, v.amex, v.leumi, v.general, v.tourist, total, zReportId],
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
// Append a SINGLE cash-expense line (test/helper use). The Z form itself uses replaceExpenses(),
// which is the richer path that maps kind + employee_id/invoice_id. This helper only stores
// description_type + a free-text employee_name — do NOT wire it to a salary/advance UI, or those
// lines won't reach the employees ledger (which joins on z_expenses.employee_id).
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
  return x.many(
    `SELECT e.*, i.invoice_number, i.total_amount AS invoice_total, s.name AS invoice_supplier,
            emp.first_name AS emp_first, emp.last_name AS emp_last
       FROM z_expenses e
       LEFT JOIN invoices i ON i.id = e.invoice_id
       LEFT JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN employees emp ON emp.id = e.employee_id
      WHERE e.z_report_id = ? ORDER BY e.id`,
    [zReportId],
  );
}

/**
 * Cash expenses not yet matched to an invoice ("תשלום במזומן ללא התאמה") — for the dashboard.
 * Only real lines (a positive amount) are surfaced. Scoped to the caller's companies.
 */
/**
 * האם עמודות ה"טופל" כבר קיימות במסד?
 *
 * 🔴 בלי הבדיקה הזו הדשבורד נופל בין הדפלוי לבין הרגע שבו הבעלים לוחץ "עדכן מסד נתונים":
 * `WHERE e.settled_at IS NULL` על עמודה שאינה קיימת היא שגיאת SQL, לא רשימה ריקה. עם הבדיקה
 * הדף עובד בשני המצבים, והכפתור פשוט לא מוצג עד שהעמודה קיימת (ראה CLAUDE.md — כל `catch`
 * שמכסה על סכימה חסרה חייב להגיע עם probe שאומר זאת בקול).
 */
export async function cashSettleReady(x = getExecutor()) {
  try {
    await x.many('SELECT settled_at FROM z_expenses LIMIT 1', []);
    await x.many('SELECT settled_at FROM z_closing_expenses LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

const SETTLE_TABLE = { zreport: 'z_expenses', zclosing: 'z_closing_expenses' };

/** החברה והחנות של שורת הוצאה, לפי מקורה — לבדיקת סקופ לפני כתיבה. */
async function cashExpenseScope(source, id, x) {
  if (source === 'zclosing') {
    return x.one(
      `SELECT st.company_id AS company_id, zc.store_id AS store_id
         FROM z_closing_expenses e JOIN z_closings zc ON zc.id = e.closing_id
         LEFT JOIN stores st ON st.id = zc.store_id WHERE e.id = ?`,
      [Number(id)],
    );
  }
  return x.one(
    `SELECT st.company_id AS company_id, z.store_id AS store_id
       FROM z_expenses e JOIN z_reports z ON z.id = e.z_report_id
       LEFT JOIN stores st ON st.id = z.store_id WHERE e.id = ?`,
    [Number(id)],
  );
}

/**
 * בדיקת הסקופ של שורת הוצאה — הביטוי היחיד שלה, כדי שכל פעולה על הוצאת מזומן תיבדק אותו דבר.
 * מזהה שמגיע מהבקשה לא ייגע בשורה של חברה/חנות אחרת; 404 מסתיר גם את עצם קיומה.
 * @returns {Promise<{company_id:number|null, store_id:number|null}>}
 */
export async function assertCashExpenseInScope(source, id, scope = null, x = getExecutor()) {
  if (!SETTLE_TABLE[source]) throw new RuleError('VALIDATION', 'מקור הוצאה לא מוכר');
  const row = await cashExpenseScope(source, id, x);
  if (!row) throw new NotFoundError(`הוצאת מזומן ${id} לא נמצאה`);
  const { companyIds, storeIds } = normalizeScope(scope);
  const outOfCompany = companyIds != null && row.company_id != null && !companyIds.includes(Number(row.company_id));
  const outOfStore = storeIds != null && row.store_id != null && !storeIds.includes(Number(row.store_id));
  if (outOfCompany || outOfStore) throw new NotFoundError(`הוצאת מזומן ${id} לא נמצאה`);
  return row;
}

/**
 * סימון הוצאת מזומן כ"טופלה" — וביטול הסימון.
 *
 * זו דרך היציאה של הוצאה שלא תקבל חשבונית ולא קישור אוטומטי: פריטה שנאספה חזרה לקופה. הסימון
 * הוא של אדם, נושא את מי ומתי, והפיך — המערכת לעולם אינה מנחשת שהוצאה טופלה.
 *
 * @param {'zreport'|'zclosing'} source
 * @param {boolean} settled  true = טופל, false = ביטול הסימון
 */
export async function setCashExpenseSettled(source, id, settled, actor, scope = null, x = getExecutor()) {
  const table = SETTLE_TABLE[source];
  if (!table) throw new RuleError('VALIDATION', 'מקור הוצאה לא מוכר');
  if (!(await cashSettleReady(x))) {
    throw new RuleError('SCHEMA', 'נדרש עדכון מסד נתונים (הגדרות ← "עדכן מסד נתונים") לפני סימון הוצאות כטופלות.');
  }
  await assertCashExpenseInScope(source, id, scope, x);

  await x.run(
    `UPDATE ${table} SET settled_at = ?, settled_by = ? WHERE id = ?`,
    [settled ? israelNowStamp() : null, settled ? (actor?.id ?? null) : null, Number(id)],
  );
  await logAction(
    { userId: actor?.id ?? null, action: settled ? 'cash_expense.settle' : 'cash_expense.unsettle',
      entityType: 'cash_expense', entityId: Number(id), details: { source } },
    x,
  );
  return { source, id: Number(id), settled };
}

/** חותמת זמן לשמירה, באותו פורמט של `created_at` (UTC — התצוגה ממירה דרך israelStamp). */
function israelNowStamp() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

export async function unmatchedCashExpenses(scope = null, limit = 30, storeId = null, x = getExecutor()) {
  // Cash expenses live in TWO subsystems and both must surface here:
  //   • z_expenses      — the older "דוח Z" flow  (z_reports)
  //   • z_closing_expenses — the "סגירת Z" register-closing flow (z_closings)
  // The register-closer enters cash expenses in "סגירת Z", so those land in z_closing_expenses; a
  // dashboard that read only z_expenses showed nothing. UNION both, keeping every real cash line
  // (positive, not yet matched to an invoice). `source` tells the view which detail page to link to.
  //
  // 🔴 שכר ומפרעה **אינם מוחרגים**. הם הוחרגו כאן פעם ("זה שכר, זה מנוהל בדף עובדים"), אבל
  // "מנוהל בדף עובדים" אינו "הותאם": שכר שיצא במזומן מהקופה ולא נקשר לשום רישום שכר הוא בדיוק
  // תשלום מזומן ללא התאמה — הכסף יצא, ואף שורה לא אומרת עבור מה. ההחרגה הגורפת הסתירה אותו
  // לגמרי, ולכן הוא לא הופיע גם כשבאמת לא בוצעה התאמה. במקום החרגה לפי סוג, מסננים לפי
  // **הקישור עצמו** — ראה `linkedKeys` למטה.
  const scR = scopeWhere(scope, 'st.company_id', 'z.store_id'); // z_reports side
  const scC = scopeWhere(scope, 'st.company_id', 'zc.store_id'); // z_closings side
  // Active-store context: filter both sides by the store (z_reports.store_id / z_closings.store_id).
  const stR = storeId ? ' AND z.store_id = ?' : '';
  const stC = storeId ? ' AND zc.store_id = ?' : '';
  const stRp = storeId ? [storeId] : [];
  const stCp = storeId ? [storeId] : [];
  // סינון ה"טופל" נכנס לשאילתה רק כשהעמודה קיימת — בין הדפלוי ללחיצה על "עדכן מסד נתונים"
  // התנאי הזה היה שגיאת SQL שמפילה את כל הדשבורד. ראה cashSettleReady.
  const settledSql = (await cashSettleReady(x)) ? ' AND e.settled_at IS NULL' : '';
  const rows = await x.many(
    `SELECT * FROM (
       SELECT e.id, e.expense_date, e.payer_name, e.purpose, e.amount, e.description_type,
              z.store_id AS store_id,
              z.z_number, 'zreport' AS source, z.id AS ref_id,
              emp.first_name AS emp_first, emp.last_name AS emp_last
         FROM z_expenses e
         JOIN z_reports z ON z.id = e.z_report_id
         JOIN stores st ON st.id = z.store_id
         LEFT JOIN employees emp ON emp.id = e.employee_id
        WHERE e.invoice_id IS NULL AND e.amount > 0${settledSql}${scR.sql}${stR}
       UNION ALL
       SELECT e.id, e.expense_date, e.payer_name, e.purpose, e.amount, e.description_type,
              zc.store_id AS store_id,
              zc.z_number, 'zclosing' AS source, zc.id AS ref_id,
              emp.first_name AS emp_first, emp.last_name AS emp_last
         FROM z_closing_expenses e
         JOIN z_closings zc ON zc.id = e.closing_id
         JOIN stores st ON st.id = zc.store_id
         LEFT JOIN employees emp ON emp.id = e.employee_id
        WHERE e.invoice_id IS NULL AND e.amount > 0${settledSql}${scC.sql}${stC}
     ) u
     ORDER BY u.expense_date DESC, u.id DESC`,
    [...scR.params, ...stRp, ...scC.params, ...stCp],
  );

  // מה **באמת** נחשב "הותאם" עבור שורת שכר/מפרעה — שלושת הקישורים שכבר קיימים במסד:
  //   • `salary_payments.cash_expense_id`  → הוצאת סגירת-Z ששילמה שכר ("הצ׳ק נפרט")
  //   • `payments.void_cash_expense_id`    → צ׳ק מבוטל שנפרע במזומן מול אותה הוצאה
  //   • `employee_advances.z_expense_id`   → מפרעה מדוח Z, משוקפת אוטומטית לספר המפרעות
  // 🔴 המפתח הוא `source|id` ולא `id` לבדו: שתי הטבלאות הן שני מרחבי מזהים נפרדים, ו-id 7
  // בסגירה אינו id 7 בדוח. בלי זה שורה אחת הייתה מסתירה שורה אחרת לגמרי.
  //
  // טבלה שעדיין לא קיימת (מסד לפני עדכון) נספרת כ"אין קישורים" — כלומר השורה **תוצג**. זה
  // הכיוון הבטוח ברשימת מטלות: להראות משהו שכבר טופל עדיף על להסתיר משהו שלא.
  const linkedKeys = new Set();
  const collect = async (sql, prefix) => {
    try {
      for (const r of await x.many(sql, [])) {
        const v = Object.values(r)[0];
        if (v != null) linkedKeys.add(`${prefix}|${Number(v)}`);
      }
    } catch { /* טבלה שטרם נוצרה */ }
  };
  await collect('SELECT cash_expense_id FROM salary_payments WHERE cash_expense_id IS NOT NULL', 'zclosing');
  await collect('SELECT cash_z_expense_id FROM salary_payments WHERE cash_z_expense_id IS NOT NULL', 'zreport');
  await collect('SELECT void_cash_expense_id FROM payments WHERE void_cash_expense_id IS NOT NULL', 'zclosing');
  await collect('SELECT z_expense_id FROM employee_advances WHERE z_expense_id IS NOT NULL', 'zreport');

  // 🔴 אין כאן יותר הסתרה לפי "חנות + סכום זהה". היה כאן כלל שאמר: אם קיים תשלום־מזומן כלשהו
  // באותה חנות ובאותו סכום, ההוצאה "מטופלת" ואינה מוצגת. הכלל הזה לא הסתכל על תאריך, על שם ולא
  // על סיבה — נמדד: תשלום מינואר העלים הוצאה מספטמבר. הוא הסתיר בשקט בדיוק את מה שהרשימה נועדה
  // לתפוס, ולכן הוא בוטל. שורה יוצאת מהרשימה רק בדרך **מפורשת**: שיוך לחשבונית, קישור שכר/מפרעה,
  // או סימון "טופל" ביד (`settled_at`).
  const out = [];
  for (const r of rows) {
    if (linkedKeys.has(`${r.source}|${Number(r.id)}`)) continue; // שכר/מפרעה שכבר נקשרו
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * שיוך הוצאת מזומן לחשבונית — **משני מקורות ההזנה**.
 *
 * קודם היה רק `matchClosingExpenseToInvoice` (סגירת Z), ולכן הוצאה שהוזנה בטופס דוח ה-Z לא
 * ניתנת הייתה לשיוך בכלל: היא הופיעה ברשימת "ללא התאמה" בלי שום דרך לצאת ממנה. הפונקציה הזו
 * מטפלת בשתיהן, מסמנת את החשבונית כשולמה במזומן, ומתריעה — התאמת מזומן היא הרגע שבו כסף
 * שיצא מהקופה מקבל הסבר, והבעלים ביקש לדעת עליה בזמן אמת.
 */
export async function matchCashExpenseToInvoice(source, id, invoiceId, actor, scope = null, x = getExecutor()) {
  const table = SETTLE_TABLE[source];
  if (!table) throw new RuleError('VALIDATION', 'מקור הוצאה לא מוכר');
  await assertCashExpenseInScope(source, id, scope, x);
  const { companyIds } = normalizeScope(scope);

  const exp = await x.one(`SELECT id, amount, payer_name, purpose FROM ${table} WHERE id = ?`, [Number(id)]);
  if (!exp) throw new NotFoundError(`הוצאת מזומן ${id} לא נמצאה`);
  const inv = await x.one(
    `SELECT i.id, i.invoice_number, i.total_amount, i.company_id, i.store_id, s.name AS supplier_name
       FROM invoices i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = ?`,
    [Number(invoiceId)],
  );
  if (!inv) throw new NotFoundError(`חשבונית ${invoiceId} לא נמצאה`);
  // הצד השני של השיוך נבדק גם הוא — אחרת מזהה חשבונית מנוחש היה קושר הוצאה לחשבונית של חברה אחרת.
  if (companyIds != null && inv.company_id != null && !companyIds.includes(Number(inv.company_id))) {
    throw new NotFoundError(`חשבונית ${invoiceId} לא נמצאה`);
  }

  await x.run(`UPDATE ${table} SET invoice_id = ?, description_type = 'invoice' WHERE id = ?`, [inv.id, Number(id)]);
  await logAction(
    { userId: actor?.id ?? null, action: 'cash_expense.match_invoice', entityType: 'invoice', entityId: inv.id,
      details: { source, expenseId: Number(id), amount: exp.amount } },
    x,
  );
  const { notify } = await import('../lib/notify.js');
  const { fromAgorot } = await import('../lib/money.js');
  const diff = Number(inv.total_amount) - Number(exp.amount);
  await notify(
    `💵 <b>הותאם תשלום במזומן לחשבונית</b>`
      + `\nחשבונית #${inv.invoice_number || inv.id}${inv.supplier_name ? ' · ' + inv.supplier_name : ''}`
      + `\nהוצאה ${fromAgorot(exp.amount)} ₪${exp.purpose ? ' · ' + exp.purpose : ''}`
      + (diff ? `\n⚠️ הפרש מול סכום החשבונית: ${fromAgorot(Math.abs(diff))} ₪` : '')
      + `\nמקור: ${source === 'zclosing' ? 'סגירת Z' : 'דוח Z'}`,
    { kind: 'cash_match', link: `/invoices/${inv.id}` },
  );
  return { source, id: Number(id), invoiceId: inv.id, diff };
}

/**
 * החשבוניות שאפשר לשייך אליהן הוצאת מזומן — **אותו סכום קודם**.
 *
 * זה לא קישוט: כשהמזומן יצא מהקופה עבור חשבונית, הסכום הוא הסימן החזק ביותר שיש, והבעלים
 * מזהה את השורה הנכונה בלי לקרוא רשימה של מאות. חשבונית בסכום זהה עולה לראש ומסומנת; השאר
 * נשארות זמינות, כי סכום שונה קורה (תשלום חלקי, עיגול, זיכוי).
 *
 * @param {number} amount  סכום ההוצאה באגורות
 */
export async function invoiceMatchCandidates(amount, scope = null, storeId = null, limit = 60, x = getExecutor()) {
  const { listPayable } = await import('./invoices.js');
  // listPayable מקבל scope כפרמטר ראשון (לא אובייקט אפשרויות); סינון החנות נעשה כאן, כי
  // `scope` שכבר צומצם לחנות הפעילה מטפל ברוב המקרים ו-storeId הוא צמצום נוסף.
  const all = await listPayable(scope, x);
  const rows = storeId ? all.filter((r) => Number(r.store_id) === Number(storeId)) : all;
  const target = Number(amount) || 0;
  const scored = rows.map((r) => ({ ...r, sameAmount: Number(r.total_amount) === target }));
  scored.sort((a, b) => (b.sameAmount ? 1 : 0) - (a.sameAmount ? 1 : 0)
    || String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')));
  return scored.slice(0, limit);
}

/**
 * צ׳קי השכר שהוזנו בדף "עובדים ומשכורות" ועדיין לא שויכו להוצאת מזומן — **אותו סכום קודם**.
 * זו ההתאמה של "העובד פרט את הצ׳ק בקופה": הכסף יצא מהמגירה, והצ׳ק חייב להתבטל אחרת הוא ייפרע
 * בבנק וישולם אותו שכר פעמיים.
 */
export async function salaryMatchCandidates(amount, scope = null, storeId = null, limit = 60, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 'sp.store_id');
  const st = storeId ? ' AND sp.store_id = ?' : '';
  let rows;
  try {
    rows = await x.many(
      `SELECT sp.id, sp.amount, sp.due_date, sp.reference, sp.method, sp.payment_id,
              e.first_name, e.last_name, st.name AS store_name
         FROM salary_payments sp
         JOIN employees e ON e.id = sp.employee_id
         JOIN stores st ON st.id = sp.store_id
        WHERE sp.cashed = 0 AND sp.cash_expense_id IS NULL${sc.sql}${st}
        ORDER BY sp.due_date DESC, sp.id DESC`,
      [...sc.params, ...(storeId ? [storeId] : [])],
    );
  } catch {
    return []; // הטבלה טרם קיימת (מסד לפני עדכון) — ראה salaryPaymentsReady
  }
  const target = Number(amount) || 0;
  const scored = rows.map((r) => ({ ...r, sameAmount: Number(r.amount) === target }));
  scored.sort((a, b) => (b.sameAmount ? 1 : 0) - (a.sameAmount ? 1 : 0)
    || String(b.due_date || '').localeCompare(String(a.due_date || '')));
  return scored.slice(0, limit);
}

/**
 * ההוצאות שכבר סומנו "טופל" — כדי שהסימון יהיה **הפיך**. סימון שאי אפשר לבטל הוא מחיקה, ופה
 * מדובר בשורת כסף אמיתית: היא נשארת במסד, יורדת מרשימת המטלות, ונשלפת חזרה בלחיצה.
 * אין כאן `linkedKeys` — שורה שסומנה ביד סומנה, בלי קשר לקישורים אחרים.
 */
export async function settledCashExpenses(scope = null, limit = 30, storeId = null, x = getExecutor()) {
  if (!(await cashSettleReady(x))) return [];
  const scR = scopeWhere(scope, 'st.company_id', 'z.store_id');
  const scC = scopeWhere(scope, 'st.company_id', 'zc.store_id');
  const stR = storeId ? ' AND z.store_id = ?' : '';
  const stC = storeId ? ' AND zc.store_id = ?' : '';
  return x.many(
    `SELECT * FROM (
       SELECT e.id, e.expense_date, e.payer_name, e.purpose, e.amount, e.description_type,
              e.settled_at, z.z_number, 'zreport' AS source, z.id AS ref_id
         FROM z_expenses e
         JOIN z_reports z ON z.id = e.z_report_id
         JOIN stores st ON st.id = z.store_id
        WHERE e.settled_at IS NOT NULL${scR.sql}${stR}
       UNION ALL
       SELECT e.id, e.expense_date, e.payer_name, e.purpose, e.amount, e.description_type,
              e.settled_at, zc.z_number, 'zclosing' AS source, zc.id AS ref_id
         FROM z_closing_expenses e
         JOIN z_closings zc ON zc.id = e.closing_id
         JOIN stores st ON st.id = zc.store_id
        WHERE e.settled_at IS NOT NULL${scC.sql}${stC}
     ) u
     ORDER BY u.settled_at DESC, u.id DESC LIMIT ?`,
    [...scR.params, ...(storeId ? [storeId] : []), ...scC.params, ...(storeId ? [storeId] : []), limit],
  );
}

/**
 * Cash payments (z_expenses) linked to a given invoice — so the invoice page can show
 * "שולם במזומן בדוח Z …" (§6). Newest first.
 */
export async function cashPaymentsForInvoice(invoiceId, x = getExecutor()) {
  return x.many(
    `SELECT e.id, e.amount, e.expense_date, z.id AS z_report_id, z.z_number, z.z_date, st.name AS store_name
       FROM z_expenses e
       JOIN z_reports z ON z.id = e.z_report_id
       JOIN stores st ON st.id = z.store_id
      WHERE e.invoice_id = ? ORDER BY e.expense_date DESC, e.id DESC`,
    [invoiceId],
  );
}

/**
 * הבסיס שאליו משווים הצהרת הפקדה: **מזומן מדוח המגירה + הוצאות המזומן**.
 *
 * 🔴 `drawer_cash`, לא `drawer_total`. הפקדת מזומן לבנק אין לה שום קשר לאשראי, לצ׳קים, להקפה או
 * לתווי קניה — השוואה מול סה"כ המגירה הראתה "חוסר" בגובה הכנסות האשראי בכל יום שבו היו כאלה,
 * כלומר כמעט תמיד. ההוצאות מתווספות חזרה כי אותו מזומן נכנס לקופה ופשוט יצא ממנה לפני השקית.
 *
 * זו הנוסחה של הבעלים, והיא מופיעה **פעמיים**: כאן (הרשימה והוואטסאפ) וב-`views/reports/_zform.ejs`
 * (החישוב החי בזמן ההקלדה). השתיים חייבות להישאר זהות — `test/zdeposit-base.test.js` נועל את זו.
 *
 * @param {{drawer_cash?: number}} zr שורת ה-Z
 * @param {number} expenses סך הוצאות המזומן באגורות
 * @returns {number} אגורות
 */
export function depositBase(zr, expenses = 0) {
  return (Number(zr?.drawer_cash) || 0) + (Number(expenses) || 0);
}

/** ההפרש שמוצג כ"חוסר / יתרה": <0 חוסר · >0 יתרה · 0 תואם. */
export function depositDiff(zr, expenses, depositAmount) {
  return (Number(depositAmount) || 0) - depositBase(zr, expenses);
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
 * Replace ALL cash-expense lines of a Z report with the given rows (the "סכם" bulk save).
 * Each row: { expenseDate, payerName, purpose, amount(agorot) }. Empty rows are dropped.
 * Atomic: a bad row rolls the whole save back, leaving the previous lines intact.
 * @returns {Promise<number>} how many lines were saved
 */
// Cash-expense kinds: manual (ידני, free text) / salary (שכר) / advance (מפרעה) / invoice
// (תשלום בגין חשבונית). salary+advance link an employee; invoice links an invoice.
export const EXPENSE_KINDS = new Set(['manual', 'petty', 'salary', 'advance', 'invoice']);

/**
 * האם השורה היא פריטה — ההוצאה היחידה שנסגרת בסימון "טופל" ולא בהתאמה, כי היא נאספת חזרה
 * לקופה ולעולם לא תקבל חשבונית.
 *
 * 🔴 גם לפי טקסט "עבור", ולא רק לפי הסוג: הסוג `petty` נוסף עכשיו, אבל במסד כבר יושבות שורות
 * שנרשמו "פריטה" בשדה החופשי לפני שהסוג היה קיים. בלי הנפילה-לאחור הזו הבעלים היה צריך להזין
 * אותן מחדש כדי לסגור אותן.
 */
export function isPettyExpense(row) {
  if (!row) return false;
  if (row.description_type === 'petty') return true;
  return /פריט/.test(String(row.purpose || ''));
}

export async function replaceExpenses(zReportId, rows, actor, x = getExecutor()) {
  await getZReport(zReportId, x);
  const clean = (rows || [])
    .map((r) => {
      // Kind: explicit if valid; else inferred for backward compatibility (an invoiceId with no
      // kind means an invoice payment — the pre-kind contract), otherwise a plain manual line.
      let kind = EXPENSE_KINDS.has(r.kind) ? r.kind : null;
      if (!kind) kind = r.invoiceId ? 'invoice' : 'manual';
      // Normalize the target field to the kind — only one of employee/invoice is kept.
      const invoiceId = kind === 'invoice' && r.invoiceId ? Number(r.invoiceId) : null;
      const employeeId = (kind === 'salary' || kind === 'advance') && r.employeeId ? Number(r.employeeId) : null;
      return {
        expenseDate: r.expenseDate || null,
        payerName: (r.payerName || '').trim() || null,
        purpose: (r.purpose || '').trim() || null,
        kind,
        employeeId,
        amount: Number.isFinite(r.amount) ? r.amount : 0,
        invoiceId,
      };
    })
    .filter((r) => r.amount > 0 || r.payerName || r.purpose || r.invoiceId || r.employeeId);
  for (const r of clean) {
    if (r.amount < 0) throw new RuleError('VALIDATION', 'סכום הוצאה חייב להיות מספר לא-שלילי');
  }
  await tx(async (t) => {
    await t.run('DELETE FROM z_expenses WHERE z_report_id = ?', [zReportId]);
    for (const r of clean) {
      await t.run(
        `INSERT INTO z_expenses (z_report_id, expense_date, payer_name, purpose, description_type, employee_id, amount, invoice_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [zReportId, r.expenseDate, r.payerName, r.purpose, r.kind, r.employeeId, r.amount, r.invoiceId],
      );
    }
  });
  await logAction({ userId: actor.id, action: 'zexpense.replace', entityType: 'z_report', entityId: zReportId, details: { count: clean.length } }, x);
  return clean.length;
}

/** Save the manager's bill recount (JSON {denom:{count,ok}}) for a Z report. */
export async function setManagerBreakdown(zReportId, breakdown, actor, x = getExecutor()) {
  await getZReport(zReportId, x);
  await x.run('UPDATE z_reports SET manager_breakdown = ? WHERE id = ?', [JSON.stringify(breakdown || {}), zReportId]);
  await logAction({ userId: actor.id, action: 'zreport.verify_bills', entityType: 'z_report', entityId: zReportId }, x);
}

/** Attach (or clear) the scan of the printed Z slip. */
export async function setZReportImage(zReportId, imagePath, actor, x = getExecutor()) {
  await getZReport(zReportId, x);
  await x.run('UPDATE z_reports SET image_path = ? WHERE id = ?', [imagePath || null, zReportId]);
  await logAction({ userId: actor.id, action: 'zreport.image', entityType: 'z_report', entityId: zReportId }, x);
}

/** The Z report immediately before this one for the same store (for the WhatsApp summary). */
export async function previousZReport(zr, x = getExecutor()) {
  return x.one(
    `SELECT * FROM z_reports
       WHERE store_id = ? AND (z_date < ? OR (z_date = ? AND id < ?))
       ORDER BY z_date DESC, id DESC LIMIT 1`,
    [zr.store_id, zr.z_date, zr.z_date, zr.id],
  );
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

/**
 * Z-sequence health across the caller's stores, for the dashboard "דוחות Z" cube.
 * For every gap in a store's numeric Z sequence, returns the Z immediately before and after it
 * (number, date, amount, id → link). ok=true when no store has a gap.
 * @returns {Promise<{ok:boolean, gaps:Array<{storeName:string, missing:number,
 *   before:object|null, after:object|null}>}>}
 */
export async function zSequenceStatus(scope = null, storeId = null, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 'st.id');
  const st = storeId ? ' AND z.store_id = ?' : '';
  const stp = storeId ? [storeId] : [];
  const rows = await x.many(
    `SELECT z.id, z.z_number, z.z_date, z.daily_total, z.store_id, st.name AS store_name
       FROM z_reports z JOIN stores st ON st.id = z.store_id
      WHERE 1 = 1${sc.sql}${st}`,
    [...sc.params, ...stp],
  );
  const byStore = new Map();
  for (const r of rows) {
    if (!byStore.has(r.store_id)) byStore.set(r.store_id, []);
    const n = Number(String(r.z_number).trim());
    byStore.get(r.store_id).push({ ...r, n: Number.isInteger(n) ? n : null });
  }
  // Each gap between two consecutive present Z numbers is ONE range [from..to] (consecutive
  // missing numbers are joined, e.g. 16-424), with the Z immediately before and after it.
  const gaps = [];
  for (const list of byStore.values()) {
    const nums = list.filter((r) => r.n != null).sort((a, b) => a.n - b.n);
    for (let i = 0; i < nums.length - 1; i += 1) {
      const a = nums[i];
      const b = nums[i + 1];
      if (b.n > a.n + 1) {
        gaps.push({ storeName: a.store_name, from: a.n + 1, to: b.n - 1, before: a, after: b });
      }
    }
  }
  return { ok: gaps.length === 0, gaps };
}
