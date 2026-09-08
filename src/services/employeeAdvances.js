// מפרעות והלוואות לעובד — הספר היחיד של "כמה העובד חייב", והחזרים שמורידים את היתרה.
//
// לפני זה היה רק מה שהוזן בדוח Z, כלומר כסף שיצא מהקופה. מפרעה שניתנה בהעברה, בצ׳ק או מהכיס לא
// הופיעה בשום מקום, ולהחזר לא היה איפה להירשם בכלל — הסכום נשאר תלוי כאילו העובד עדיין חייב אותו.
//
// לכן שני דברים:
//   • מפרעה אפשר לרשום ידנית, עם אמצעי התשלום שבו באמת ניתנה;
//   • מפרעה שיצאה מ-Z **משוקפת לכאן** (`z_expense_id`) כדי שגם עליה יהיו החזרים ויתרה. הסכום שלה
//     נשאר בבעלות ה-Z: הסנכרון מעדכן אותו מהמקור ולא להפך, ועריכה מכאן חסומה.
//
// יתרה = סכום פחות סך ההחזרים. אין עמודת "הוחזר" ואין דגל "סגור": מפרעה מוחזרת בפעימות, ומצב
// שמחושב מהשורות לא יכול להתנתק מהן.
import { getExecutor, nowTs } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeWhere } from '../lib/scope.js';
import { logAction } from './audit.js';

export const ADVANCE_KINDS = [
  { value: 'advance', label: 'מפרעה' },
  { value: 'loan', label: 'הלוואה' },
];
export const ADVANCE_METHODS = [
  { value: 'register', label: 'מהקופה' },
  { value: 'cash', label: 'מזומן' },
  { value: 'check', label: 'צ׳ק' },
  { value: 'transfer', label: 'העברה' },
];
export const REPAY_SOURCES = [
  { value: 'salary', label: 'ניכוי מהשכר' },
  { value: 'cash', label: 'החזר במזומן' },
  { value: 'other', label: 'אחר' },
];
const KIND_VALUES = ADVANCE_KINDS.map((k) => k.value);
const SOURCE_VALUES = REPAY_SOURCES.map((s) => s.value);
export const kindLabel = (k) => (ADVANCE_KINDS.find((x) => x.value === k) || {}).label || k;
export const methodLabel = (m) => (ADVANCE_METHODS.find((x) => x.value === m) || {}).label || (m || '—');
export const repaySourceLabel = (s) => (REPAY_SOURCES.find((x) => x.value === s) || {}).label || s;

const clean = (v) => (v ?? '').toString().trim() || null;

/** האם הסכימה עודכנה? (הבעלים מריץ את העדכון ידנית — כמו ב-voidedChecks.js.) */
export async function advancesReady(x = getExecutor()) {
  try {
    await x.many('SELECT id FROM employee_advances LIMIT 1', []);
    await x.many('SELECT id FROM employee_advance_repayments LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

/**
 * משקף לכאן כל שורת מפרעה שהוזנה בדוח Z, ומעדכן שורות ששוקפו אם ה-Z שונה מאז.
 *
 * אידמפוטנטי דרך `z_expense_id UNIQUE`. רץ בטעינת הדף ולפני רישום החזר, כי אחרת מפרעה שנרשמה
 * בקופה אתמול לא הייתה ניתנת להחזר היום. שורות שכר (`salary`) **אינן** מפרעה ולא משוקפות.
 */
export async function syncZAdvances(x = getExecutor()) {
  let zRows;
  try {
    zRows = await x.many(
      `SELECT e.id, e.employee_id, e.amount, e.expense_date, z.store_id
         FROM z_expenses e
         JOIN z_reports z ON z.id = e.z_report_id
        WHERE e.employee_id IS NOT NULL AND e.description_type = 'advance'`,
      [],
    );
  } catch {
    return { inserted: 0, updated: 0, removed: 0 };
  }
  const mirrored = await x.many('SELECT id, z_expense_id, amount, issued_date FROM employee_advances WHERE z_expense_id IS NOT NULL', []);
  const byZ = new Map(mirrored.map((m) => [Number(m.z_expense_id), m]));
  const live = new Set(zRows.map((r) => Number(r.id)));

  let inserted = 0; let updated = 0; let removed = 0;
  for (const z of zRows) {
    const hit = byZ.get(Number(z.id));
    if (!hit) {
      await x.run(
        `INSERT INTO employee_advances (employee_id, store_id, kind, issued_date, amount, method, note, z_expense_id)
         VALUES (?, ?, 'advance', ?, ?, 'register', ?, ?)`,
        [z.employee_id, z.store_id, z.expense_date, Math.round(Number(z.amount)), 'נרשמה בדוח Z', z.id],
      );
      inserted += 1;
    } else if (Number(hit.amount) !== Math.round(Number(z.amount)) || hit.issued_date !== z.expense_date) {
      // ה-Z הוא הבעלים של הסכום — מעדכנים ממנו, לא אליו.
      await x.run('UPDATE employee_advances SET amount = ?, issued_date = ? WHERE id = ?',
        [Math.round(Number(z.amount)), z.expense_date, hit.id]);
      updated += 1;
    }
  }
  // שורת Z שנמחקה: המפרעה לא הייתה. נמחקת רק אם לא נרשמו עליה החזרים — החזר הוא עובדה שקרתה.
  for (const m of mirrored) {
    if (live.has(Number(m.z_expense_id))) continue;
    const r = await x.one('SELECT COUNT(*) AS n FROM employee_advance_repayments WHERE advance_id = ?', [m.id]);
    if (Number(r?.n || 0) === 0) { await x.run('DELETE FROM employee_advances WHERE id = ?', [m.id]); removed += 1; }
  }
  return { inserted, updated, removed };
}

/**
 * המפרעות בתחום ההרשאה, כל אחת עם ההחזרים שלה, כמה הוחזר ומה היתרה.
 * `status`: open (לא הוחזר כלום) · partial (חלקי) · repaid (נסגר).
 */
export async function listAdvances({ storeId = null, employeeId = null, scope = null } = {}, x = getExecutor()) {
  if (!(await advancesReady(x))) return [];
  const sc = scopeWhere(scope, 'st.company_id', 'a.store_id');
  const params = [...sc.params];
  let filter = '';
  if (storeId) { filter += ' AND a.store_id = ?'; params.push(Number(storeId)); }
  if (employeeId) { filter += ' AND a.employee_id = ?'; params.push(Number(employeeId)); }
  const rows = await x.many(
    `SELECT a.*, e.first_name, e.last_name, st.name AS store_name, u.name AS created_by_name
       FROM employee_advances a
       JOIN employees e ON e.id = a.employee_id
       JOIN stores st ON st.id = a.store_id
       LEFT JOIN users u ON u.id = a.created_by
      WHERE 1 = 1${sc.sql}${filter}
      ORDER BY a.issued_date DESC, a.id DESC`,
    params,
  );
  if (!rows.length) return [];
  const reps = await x.many(
    `SELECT r.*, u.name AS created_by_name, sp.reference AS salary_reference
       FROM employee_advance_repayments r
       LEFT JOIN users u ON u.id = r.created_by
       LEFT JOIN salary_payments sp ON sp.id = r.salary_payment_id
      ORDER BY r.repaid_date, r.id`,
    [],
  );
  const byAdvance = new Map();
  for (const r of reps) {
    const k = Number(r.advance_id);
    if (!byAdvance.has(k)) byAdvance.set(k, []);
    byAdvance.get(k).push(r);
  }
  return rows.map((a) => {
    const repayments = byAdvance.get(Number(a.id)) || [];
    const repaid = repayments.reduce((n, r) => n + Number(r.amount), 0);
    const balance = Number(a.amount) - repaid;
    return {
      ...a,
      repayments,
      repaid,
      balance,
      fromZ: a.z_expense_id != null,
      status: balance <= 0 ? 'repaid' : repaid > 0 ? 'partial' : 'open',
    };
  });
}

/** סך היתרות הפתוחות לכל עובד — מה שבאמת מעניין: כמה הוא חייב עכשיו. */
export async function openBalances({ storeId = null, scope = null } = {}, x = getExecutor()) {
  const rows = await listAdvances({ storeId, scope }, x);
  const byEmp = new Map();
  for (const a of rows) {
    if (a.balance <= 0) continue;
    const k = Number(a.employee_id);
    const cur = byEmp.get(k) || { employee_id: k, first_name: a.first_name, last_name: a.last_name, balance: 0, open: 0 };
    cur.balance += a.balance;
    cur.open += 1;
    byEmp.set(k, cur);
  }
  return [...byEmp.values()].sort((a, b) => b.balance - a.balance);
}

export async function getAdvance(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM employee_advances WHERE id = ?', [Number(id)]);
  if (!row) throw new NotFoundError(`מפרעה ${id} לא נמצאה`);
  return row;
}

/**
 * רישום מפרעה/הלוואה שלא יצאה מהקופה.
 * הקורא כבר אימת את `storeId` מול הסקופ (assertStoreAllowed) — כמו כל כתיבה כאן.
 * @param {{storeId, employeeId, kind, issuedDate, amount, method, reference, note}} input  amount באגורות
 */
export async function createAdvance(input, actor, x = getExecutor()) {
  const storeId = Number(input.storeId) || null;
  const employeeId = Number(input.employeeId) || null;
  const kind = String(input.kind || 'advance');
  const issuedDate = String(input.issuedDate || '').trim();
  const amount = Math.round(Number(input.amount) || 0);

  if (!storeId) throw new RuleError('VALIDATION', 'יש לבחור חנות');
  if (!employeeId) throw new RuleError('VALIDATION', 'יש לבחור עובד');
  if (!KIND_VALUES.includes(kind)) throw new RuleError('VALIDATION', 'סוג לא תקין');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issuedDate)) throw new RuleError('VALIDATION', 'יש להזין תאריך תקין');
  if (amount <= 0) throw new RuleError('VALIDATION', 'יש להזין סכום גדול מאפס');

  const emp = await x.one('SELECT id FROM employees WHERE id = ?', [employeeId]);
  if (!emp) throw new NotFoundError(`עובד ${employeeId} לא נמצא`);

  const info = await x.run(
    `INSERT INTO employee_advances (employee_id, store_id, kind, issued_date, amount, method, reference, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [employeeId, storeId, kind, issuedDate, amount, clean(input.method), clean(input.reference), clean(input.note), actor?.id ?? null],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'advance.create', entityType: 'employee_advance', entityId: info.lastInsertRowid,
      details: { employeeId, amount, kind } },
    x,
  );
  return getAdvance(info.lastInsertRowid, x);
}

/**
 * רישום החזר. ההחזר לא יכול לעבור את היתרה — עודף אינו החזר, וסכום שלילי היה מגדיל חוב בשקט.
 * @param {{repaidDate, amount, source, salaryPaymentId, note}} input
 */
export async function repayAdvance(advanceId, input, actor, x = getExecutor()) {
  const advance = await getAdvance(advanceId, x);
  const repaidDate = String(input.repaidDate || '').trim();
  const amount = Math.round(Number(input.amount) || 0);
  const source = String(input.source || 'salary');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(repaidDate)) throw new RuleError('VALIDATION', 'יש להזין תאריך תקין');
  if (amount <= 0) throw new RuleError('VALIDATION', 'יש להזין סכום גדול מאפס');
  if (!SOURCE_VALUES.includes(source)) throw new RuleError('VALIDATION', 'מקור ההחזר לא תקין');

  const prior = await x.one('SELECT COALESCE(SUM(amount),0) AS n FROM employee_advance_repayments WHERE advance_id = ?', [advance.id]);
  const balance = Number(advance.amount) - Number(prior?.n || 0);
  if (balance <= 0) throw new RuleError('R', 'המפרעה כבר הוחזרה במלואה');
  if (amount > balance) {
    const { formatIls } = await import('../lib/money.js');
    throw new RuleError('R', `ההחזר (${formatIls(amount)}) גדול מהיתרה (${formatIls(balance)})`);
  }

  let salaryPaymentId = Number(input.salaryPaymentId) || null;
  if (salaryPaymentId) {
    const sp = await x.one('SELECT id, employee_id FROM salary_payments WHERE id = ?', [salaryPaymentId]);
    if (!sp) throw new NotFoundError('תשלום השכר לא נמצא');
    // ניכוי משכר של עובד אחר הוא כמעט תמיד בחירה שגויה בבורר, לא כוונה.
    if (Number(sp.employee_id) !== Number(advance.employee_id)) {
      throw new RuleError('R', 'תשלום השכר שנבחר שייך לעובד אחר');
    }
  }

  const info = await x.run(
    `INSERT INTO employee_advance_repayments (advance_id, repaid_date, amount, source, salary_payment_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [advance.id, repaidDate, amount, source, salaryPaymentId, clean(input.note), actor?.id ?? null],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'advance.repay', entityType: 'employee_advance', entityId: advance.id,
      details: { amount, source, repaymentId: info.lastInsertRowid } },
    x,
  );
  return { repaymentId: info.lastInsertRowid, balance: balance - amount, closed: balance - amount <= 0 };
}

/** ביטול החזר שנרשם בטעות. המפרעה עצמה נשארת. */
export async function deleteRepayment(repaymentId, actor, x = getExecutor()) {
  const row = await x.one('SELECT * FROM employee_advance_repayments WHERE id = ?', [Number(repaymentId)]);
  if (!row) throw new NotFoundError('ההחזר לא נמצא');
  await x.run('DELETE FROM employee_advance_repayments WHERE id = ?', [Number(repaymentId)]);
  await logAction(
    { userId: actor?.id ?? null, action: 'advance.repay_delete', entityType: 'employee_advance', entityId: Number(row.advance_id),
      details: { repaymentId: Number(repaymentId), amount: Number(row.amount) } },
    x,
  );
}

/**
 * מחיקת מפרעה. שורה ששוקפה מ-Z אינה נמחקת כאן — היא שייכת ל-Z, ומחיקה כאן הייתה חוזרת בסנכרון
 * הבא ומשאירה רושם שהמחיקה נכשלה. מפרעה שכבר נרשמו עליה החזרים אינה נמחקת גם היא.
 */
export async function deleteAdvance(id, actor, x = getExecutor()) {
  const advance = await getAdvance(id, x);
  if (advance.z_expense_id != null) {
    throw new RuleError('R', 'המפרעה הזו נרשמה בדוח Z — יש למחוק אותה שם, לא כאן');
  }
  const r = await x.one('SELECT COUNT(*) AS n FROM employee_advance_repayments WHERE advance_id = ?', [advance.id]);
  if (Number(r?.n || 0) > 0) throw new RuleError('R', 'נרשמו החזרים על המפרעה — יש למחוק אותם קודם');
  await x.run('DELETE FROM employee_advances WHERE id = ?', [advance.id]);
  await logAction({ userId: actor?.id ?? null, action: 'advance.delete', entityType: 'employee_advance', entityId: advance.id }, x);
}

/** תשלומי השכר של עובד שאפשר לתלות בהם ניכוי — לבורר בחלון ההחזר. */
export async function salaryOptionsFor(employeeId, x = getExecutor()) {
  try {
    return await x.many(
      `SELECT id, due_date, amount, reference, method FROM salary_payments
        WHERE employee_id = ? ORDER BY due_date DESC, id DESC LIMIT 24`,
      [Number(employeeId)],
    );
  } catch {
    return [];
  }
}

export { nowTs };
