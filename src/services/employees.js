import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { normalizePhone } from '../lib/employeeImport.js';
import { logAction } from './audit.js';

// "עובדים ומשכורות" — staff list + a tracking table of advances (מפרעות) and salary lines
// entered on Z reports. An advance/salary line on a Z references an employee (z_expenses.employee_id).

export async function listEmployees({ includeInactive = false } = {}, x = getExecutor()) {
  const where = includeInactive ? '' : 'WHERE active = 1';
  return x.many(`SELECT * FROM employees ${where} ORDER BY last_name, first_name`, []);
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
 */
export async function listEmployeeLedger({ employeeId = null } = {}, x = getExecutor()) {
  const where = employeeId ? 'AND e.employee_id = ?' : '';
  const params = employeeId ? [employeeId] : [];
  return x.many(
    `SELECT e.id, e.expense_date, e.amount, e.description_type AS kind, e.purpose,
            emp.id AS employee_id, emp.first_name, emp.last_name,
            z.id AS z_report_id, z.z_number, z.z_date, st.name AS store_name
       FROM z_expenses e
       JOIN employees emp ON emp.id = e.employee_id
       JOIN z_reports z ON z.id = e.z_report_id
       JOIN stores st ON st.id = z.store_id
      WHERE e.employee_id IS NOT NULL AND e.description_type IN ('advance','salary') ${where}
      ORDER BY e.expense_date DESC, e.id DESC`,
    params,
  );
}

/**
 * Per-employee totals of advances and salary lines, for the summary table.
 * @returns {Promise<Array<{id, first_name, last_name, active, advances, salary, lines}>>}
 */
export async function employeeTotals(x = getExecutor()) {
  const employees = await listEmployees({ includeInactive: true }, x);
  const rows = await x.many(
    `SELECT employee_id, description_type AS kind, COALESCE(SUM(amount),0) AS amt, COUNT(*) AS n
       FROM z_expenses
      WHERE employee_id IS NOT NULL AND description_type IN ('advance','salary')
      GROUP BY employee_id, description_type`,
    [],
  );
  const byEmp = new Map();
  for (const r of rows) {
    const cur = byEmp.get(r.employee_id) || { advances: 0, salary: 0, lines: 0 };
    if (r.kind === 'advance') cur.advances += Number(r.amt);
    else if (r.kind === 'salary') cur.salary += Number(r.amt);
    cur.lines += Number(r.n);
    byEmp.set(r.employee_id, cur);
  }
  return employees.map((e) => ({ ...e, ...(byEmp.get(e.id) || { advances: 0, salary: 0, lines: 0 }) }));
}
