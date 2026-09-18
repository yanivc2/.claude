import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { normalizePhone } from '../lib/employeeImport.js';
import { filterByStoreLinks, scopeWhere } from '../lib/scope.js';
import { logAction } from './audit.js';

// "עובדים ומשכורות" — staff list + a tracking table of advances (מפרעות) and salary lines
// entered on Z reports. An advance/salary line on a Z references an employee (z_expenses.employee_id).

/**
 * Staff list, SCOPED through employee_stores (same rule as suppliers — see
 * lib/scope.js#filterByStoreLinks): an employee with no store links is shared with everyone; one
 * with links is visible only where at least one of those stores is in scope. Each row gets a
 * `stores` array so the screen can show which branches the employee belongs to.
 */
export async function listEmployees({ includeInactive = false, scope = null } = {}, x = getExecutor()) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  const rows = await x.many(`SELECT * FROM employees ${where} ORDER BY last_name, first_name`, []);
  return filterByStoreLinks(rows, 'employee_stores', 'employee_id', scope, x);
}

/** The store ids an employee is linked to ([] = every store). */
export async function employeeStoreIds(employeeId, x = getExecutor()) {
  try {
    const rows = await x.many('SELECT store_id FROM employee_stores WHERE employee_id = ?', [employeeId]);
    return rows.map((r) => Number(r.store_id));
  } catch {
    return [];
  }
}

/**
 * Replace an employee's store links. `storeIds` must already be validated against the caller's
 * scope by the route (assertStoreAllowed) — this only writes. An empty list clears the links,
 * which means "every store" again.
 */
export async function setEmployeeStores(employeeId, storeIds, actor, x = getExecutor()) {
  await getEmployee(employeeId, x);
  await x.run('DELETE FROM employee_stores WHERE employee_id = ?', [employeeId]);
  for (const sid of [...new Set((storeIds || []).map(Number).filter(Boolean))]) {
    await x.run('INSERT INTO employee_stores (employee_id, store_id) VALUES (?, ?)', [employeeId, sid]);
  }
  await logAction(
    { userId: actor?.id ?? null, action: 'employee.set_stores', entityType: 'employee', entityId: employeeId, details: { storeIds } },
    x,
  );
}

export async function getEmployee(id, x = getExecutor()) {
  const row = await x.one('SELECT * FROM employees WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`עובד ${id} לא נמצא`);
  return row;
}

export async function createEmployee({ firstName, lastName, phone }, actor, x = getExecutor()) {
  const f = (firstName ?? '').trim();
  const l = (lastName ?? '').trim();
  if (!f || !l) throw new RuleError('VALIDATION', 'שם פרטי ושם משפחה חובה');
  const ph = normalizePhone(phone) || null;
  const info = await x.run(
    'INSERT INTO employees (first_name, last_name, phone, created_by) VALUES (?, ?, ?, ?)',
    [f, l, ph, actor?.id ?? null],
  );
  await logAction({ userId: actor?.id, action: 'employee.create', entityType: 'employee', entityId: info.lastInsertRowid, details: { name: `${f} ${l}` } }, x);
  return getEmployee(info.lastInsertRowid, x);
}

/**
 * Bulk-import employees from a parsed staff list (see lib/employeeImport.js#parseEmployeeFile).
 * Dedupes by phone number: a row whose phone already belongs to an existing employee — or to an
 * earlier row in the same file — is skipped so the list never gains duplicates. Rows without a
 * phone can't be deduped, so they're always added (name is required).
 * @param {Array<{firstName,lastName,phone}>} rows
 * @returns {{added:number, skipped:number, invalid:number}}
 */
export async function importEmployees(rows, actor, x = getExecutor()) {
  const existing = await x.many('SELECT phone FROM employees', []);
  const seen = new Set(existing.map((e) => normalizePhone(e.phone)).filter(Boolean));
  let added = 0;
  let skipped = 0;
  let invalid = 0;
  for (const r of rows || []) {
    const f = (r.firstName ?? '').trim();
    const l = (r.lastName ?? '').trim();
    if (!f && !l) { invalid += 1; continue; }
    const ph = normalizePhone(r.phone);
    if (ph && seen.has(ph)) { skipped += 1; continue; } // duplicate by phone — don't add
    const info = await x.run(
      'INSERT INTO employees (first_name, last_name, phone, created_by) VALUES (?, ?, ?, ?)',
      [f || l, f ? l : '', ph || null, actor?.id ?? null],
    );
    if (ph) seen.add(ph);
    added += 1;
    await logAction({ userId: actor?.id, action: 'employee.import', entityType: 'employee', entityId: info.lastInsertRowid, details: { name: `${f} ${l}`.trim() } }, x);
  }
  return { added, skipped, invalid };
}

/** Soft-delete an employee if they have tracked lines (keep history); hard-delete otherwise. */
export async function deleteEmployee(id, actor, x = getExecutor()) {
  await getEmployee(id, x);
  const used = await x.one('SELECT COUNT(*) AS n FROM z_expenses WHERE employee_id = ?', [id]);
  if (used && used.n > 0) {
    await x.run('UPDATE employees SET active = 0 WHERE id = ?', [id]);
    await logAction({ userId: actor?.id, action: 'employee.deactivate', entityType: 'employee', entityId: id }, x);
    return { deactivated: true };
  }
  await x.run('DELETE FROM employees WHERE id = ?', [id]);
  await logAction({ userId: actor?.id, action: 'employee.delete', entityType: 'employee', entityId: id }, x);
  return { deactivated: false };
}

/**
 * The tracking table: every salary/advance line entered on a Z report, joined to its employee
 * and Z. `kind` is 'advance' (מפרעה) or 'salary' (שכר). Newest first.
 *
 * 🔴 SCOPED by the Z report's store, not by the employee's links. An employee with no store links
 * is shared with every branch (filterByStoreLinks), so filtering the ledger by who the employee is
 * would leave a מידנייט screen showing a salary line paid at סופר על הדרך — measured. What the
 * line belongs to is the register it came out of, which is `z_reports.store_id`.
 */
export async function listEmployeeLedger(
  { employeeId = null, storeId = null, scope = null } = {},
  x = getExecutor(),
) {
  const sc = scopeWhere(scope, 'st.company_id', 'z.store_id');
  const params = [...sc.params];
  let where = '';
  if (employeeId) { where += ' AND e.employee_id = ?'; params.push(Number(employeeId)); }
  if (storeId) { where += ' AND z.store_id = ?'; params.push(Number(storeId)); }
  return x.many(
    `SELECT e.id, e.expense_date, e.amount, e.description_type AS kind, e.purpose,
            emp.id AS employee_id, emp.first_name, emp.last_name,
            z.id AS z_report_id, z.z_number, z.z_date, z.store_id, st.name AS store_name
       FROM z_expenses e
       JOIN employees emp ON emp.id = e.employee_id
       JOIN z_reports z ON z.id = e.z_report_id
       JOIN stores st ON st.id = z.store_id
      WHERE e.employee_id IS NOT NULL AND e.description_type IN ('advance','salary')
            ${sc.sql}${where}
      ORDER BY e.expense_date DESC, e.id DESC`,
    params,
  );
}

/**
 * Per-employee totals of advances and salary lines, for the summary table.
 * @returns {Promise<Array<{id, first_name, last_name, active, advances, salary, lines}>>}
 */
export async function employeeTotals({ storeId = null, scope = null } = {}, x = getExecutor()) {
  const employees = await listEmployees({ includeInactive: true, scope }, x);
  // 🔴 נגזר מאותן שורות בדיוק שהטבלה "מעקב מפרעות ושכר" מציגה, ולא משאילתת GROUP BY משלו: קודם
  // היה כאן סכום על **כל** החנויות ליד רשימה מסוננת, כלומר מסך של חנות אחת הראה סכום של כולן
  // ואי אפשר היה לדעת שהוא לא שלה. מקור אחד = שתי הטבלאות לא יכולות להיפרד בשקט. (סיכום ב-JS ולא
  // ב-SQL גם עוקף את מגבלת pg-mem — GROUP BY מעל join.)
  const ledger = await listEmployeeLedger({ storeId, scope }, x);
  const byEmp = new Map();
  for (const r of ledger) {
    const cur = byEmp.get(Number(r.employee_id)) || { advances: 0, salary: 0, lines: 0 };
    if (r.kind === 'advance') cur.advances += Number(r.amount);
    else if (r.kind === 'salary') cur.salary += Number(r.amount);
    cur.lines += 1;
    byEmp.set(Number(r.employee_id), cur);
  }
  return employees.map((e) => ({
    ...e,
    ...(byEmp.get(Number(e.id)) || { advances: 0, salary: 0, lines: 0 }),
  }));
}
