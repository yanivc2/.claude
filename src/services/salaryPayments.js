// "תשלומי שכר" — how each employee's wage was actually paid, per store.
//
// Distinct from a supplier payment: there is no supplier and no invoice, only who was paid, by what
// means, its identifier, the date it is FOR, and how much. The rows live on the עובדים ומשכורות
// page and are scoped like everything else, so a branch sees only its own.
//
// The case that makes this more than a list: a wage CHECK the employee cashes at the till instead
// of at the bank ("פורט את הצק"). The money leaves the register — so it appears as a cash expense
// on a Z closing — and the check itself must be voided, or it stays outstanding forever while the
// same wage has already been paid twice over in the books. `markCashed` is that reconciliation:
// it ties the wage row to the Z-closing expense that paid it out and, when the wage was paid by a
// real check recorded in /payments, voids that check with the reason "נפרע במזומן עבור שכר".
import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { scopeWhere, normalizeScope } from '../lib/scope.js';
import { logAction } from './audit.js';

export const SALARY_METHODS = [
  { value: 'check', label: 'צ׳ק' },
  { value: 'cash', label: 'מזומן' },
  { value: 'transfer', label: 'העברה' },
  { value: 'batch', label: 'מקבץ' },
];
const METHOD_VALUES = SALARY_METHODS.map((m) => m.value);
export const methodLabel = (m) => (SALARY_METHODS.find((x) => x.value === m) || {}).label || m;

/** Rows for the rubric, newest due-date first, with the employee and store names joined in. */
export async function listSalaryPayments({ storeId = null, scope = null, limit = 100 } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 'sp.store_id');
  const params = [...sc.params];
  let filter = '';
  if (storeId) { filter = ' AND sp.store_id = ?'; params.push(Number(storeId)); }
  params.push(limit);
  return x.many(
    `SELECT sp.*, e.first_name, e.last_name, st.name AS store_name
       FROM salary_payments sp
       JOIN employees e ON e.id = sp.employee_id
       JOIN stores st ON st.id = sp.store_id
      WHERE 1 = 1${sc.sql}${filter}
      ORDER BY sp.due_date DESC, sp.id DESC LIMIT ?`,
    params,
  );
}

export async function getSalaryPayment(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM salary_payments WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`תשלום שכר ${id} לא נמצא`);
  return row;
}

/**
 * Record one wage payment. The caller must have already validated `storeId` against the scope
 * (assertStoreAllowed) — this service trusts it, like every other write here.
 * @param {{storeId, employeeId, method, reference, dueDate, amount}} input amount in agorot
 */
export async function createSalaryPayment(input, actor, x = getExecutor()) {
  const storeId = Number(input.storeId) || null;
  const employeeId = Number(input.employeeId) || null;
  const method = String(input.method || 'check');
  const dueDate = String(input.dueDate || '').trim();
  const amount = Math.round(Number(input.amount) || 0);
  const reference = (input.reference ?? '').toString().trim() || null;

  if (!storeId) throw new RuleError('VALIDATION', 'יש לבחור חנות');
  if (!employeeId) throw new RuleError('VALIDATION', 'יש לבחור עובד');
  if (!METHOD_VALUES.includes(method)) throw new RuleError('VALIDATION', 'אמצעי תשלום לא תקין');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) throw new RuleError('VALIDATION', 'יש להזין תאריך תקין');
  if (amount <= 0) throw new RuleError('VALIDATION', 'יש להזין סכום גדול מאפס');
  // A check or a transfer without its identifier cannot be reconciled to anything later.
  if ((method === 'check' || method === 'transfer' || method === 'batch') && !reference) {
    throw new RuleError('VALIDATION', 'יש להזין מספר אסמכתה (מספר צ׳ק / אסמכתה / מקבץ)');
  }

  const emp = await x.one('SELECT id FROM employees WHERE id = ?', [employeeId]);
  if (!emp) throw new NotFoundError(`עובד ${employeeId} לא נמצא`);

  const info = await x.run(
    `INSERT INTO salary_payments (store_id, employee_id, method, reference, due_date, amount, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [storeId, employeeId, method, reference, dueDate, amount, actor?.id ?? null],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'salary.create', entityType: 'salary_payment', entityId: info.lastInsertRowid, details: { employeeId, amount, method } },
    x,
  );
  return getSalaryPayment(info.lastInsertRowid, x);
}

export async function deleteSalaryPayment(id, actor, x = getExecutor()) {
  await getSalaryPayment(id, x);
  await x.run('DELETE FROM salary_payments WHERE id = ?', [id]);
  await logAction({ userId: actor?.id ?? null, action: 'salary.delete', entityType: 'salary_payment', entityId: id }, x);
}

/**
 * Recent cash expenses that could be the till payout for a wage check — the same rows the Z-closing
 * page shows under "הוצאות מזומן". Offered as match candidates; nothing is matched automatically,
 * because paying a wage out of the register and recording a wage check are two entries a human
 * made separately and only a human knows they are the same event.
 */
export async function cashExpenseCandidates({ storeId = null, scope = null, limit = 60 } = {}, x = getExecutor()) {
  const { companyIds, storeIds } = normalizeScope(scope);
  const rows = await x.many(
    `SELECT e.id, e.expense_date, e.payer_name, e.purpose, e.amount, e.description_type,
            zc.id AS closing_id, zc.z_number, zc.store_id AS store_id, st.name AS store_name,
            st.company_id AS company_id
       FROM z_closing_expenses e
       JOIN z_closings zc ON zc.id = e.closing_id
       LEFT JOIN stores st ON st.id = zc.store_id
      WHERE e.amount > 0
      ORDER BY e.expense_date DESC, e.id DESC`,
    [],
  );
  // Scope filtered in JS: the query already joins three tables and pg-mem refuses an indexed-id
  // lookup on a joined table (see lib/scope.js#scopeClause). The list is small and capped.
  const taken = new Set(
    (await x.many('SELECT cash_expense_id FROM salary_payments WHERE cash_expense_id IS NOT NULL', []))
      .map((r) => Number(r.cash_expense_id)),
  );
  return rows
    .filter((r) => companyIds == null || (r.company_id != null && companyIds.includes(Number(r.company_id))))
    .filter((r) => storeIds == null || r.store_id == null || storeIds.includes(Number(r.store_id)))
    .filter((r) => !storeId || Number(r.store_id) === Number(storeId))
    .filter((r) => !taken.has(Number(r.id)))
    .slice(0, limit);
}

/**
 * "הצ׳ק נפרט" — the employee cashed the wage check at the till. Ties the wage row to the Z-closing
 * cash expense that paid it out, and voids the underlying check so it stops looking outstanding.
 *
 * The void is the whole point: the wage was paid once, from the register. Leaving the check live
 * would have it clear at the bank later and pay the same wage twice. It is voided with the reason
 * `cashed_for_salary`, which is what puts it on the צ'קים מבוטלים page with its match recorded.
 *
 * @param {number} id            salary_payments.id
 * @param {number} cashExpenseId z_closing_expenses.id — the till payout
 */
export async function markCashed(id, cashExpenseId, actor, x = getExecutor()) {
  const row = await getSalaryPayment(id, x);
  if (Number(row.cashed)) throw new RuleError('R', 'תשלום השכר כבר סומן כנפרט');
  const expense = await x.one('SELECT * FROM z_closing_expenses WHERE id = ?', [Number(cashExpenseId)]);
  if (!expense) throw new NotFoundError('הוצאת המזומן לא נמצאה');
  const clash = await x.one('SELECT id FROM salary_payments WHERE cash_expense_id = ?', [Number(cashExpenseId)]);
  if (clash) throw new RuleError('R', `הוצאת המזומן כבר שויכה לתשלום שכר #${clash.id}`);

  // Void FIRST, then flag. voidPayment runs its own transaction (and refuses a check that is
  // already voided or already matched to a bank movement), so nesting one here would throw
  // "cannot start a transaction within a transaction" — and doing it in this order means a refused
  // void leaves the wage row untouched rather than marked cashed against a live check.
  if (row.payment_id) {
    const { voidPaymentWithReason } = await import('./payments.js');
    await voidPaymentWithReason(
      row.payment_id,
      { reason: 'cashed_for_salary', cashExpenseId: Number(cashExpenseId) },
      actor,
      x,
    );
  }
  await x.run('UPDATE salary_payments SET cashed = 1, cash_expense_id = ? WHERE id = ?', [Number(cashExpenseId), id]);
  await logAction(
    { userId: actor?.id ?? null, action: 'salary.cashed', entityType: 'salary_payment', entityId: id, details: { cashExpenseId } },
    x,
  );
  return getSalaryPayment(id, x);
}

/** Undo the match (a mis-click). The voided check is NOT un-voided — that is a separate decision. */
export async function unmatchCashed(id, actor, x = getExecutor()) {
  await getSalaryPayment(id, x);
  await x.run('UPDATE salary_payments SET cashed = 0, cash_expense_id = NULL WHERE id = ?', [id]);
  await logAction({ userId: actor?.id ?? null, action: 'salary.uncashed', entityType: 'salary_payment', entityId: id }, x);
  return getSalaryPayment(id, x);
}
