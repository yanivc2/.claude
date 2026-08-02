import { getExecutor, nowTs } from '../db/adapter.js';
import { NotFoundError, RuleError, AuthError } from '../lib/errors.js';
import { config } from '../config.js';
import { logAction } from './audit.js';

// Pension-file COMPLIANCE tracking (מעקב פנסיה) — not a payroll calculation. It tracks two legal
// duties for the business:
//   1. Opening the employee's pension file ON TIME after hiring (statutory deadline: ~3 months
//      for an employee who already had an active fund, ~6 months for a new one — configurable).
//   2. Sending the release notice (טופס 161) to the fund when the employee is terminated.
// The service computes the deadline + a risk level per employee, so the owner can act before a
// legal breach.

function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
}

function daysBetween(aIso, bIso) {
  return Math.round((Date.parse(bIso) - Date.parse(aIso)) / 86400000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Decorate a raw employee row with the computed pension deadline and a risk assessment.
 * risk.level ∈ 'ok' | 'due_soon' | 'overdue' | 'release_due'. `todayIso` is injectable for tests.
 */
export function assess(emp, todayIso = today()) {
  const months = emp.prior_pension ? config.pension.priorMonths : config.pension.newMonths;
  const deadline = addMonths(emp.start_date, months);
  const out = { ...emp, pension_deadline: deadline };

  if (emp.status === 'terminated') {
    // The live duty for a terminated employee is the release notice (161) to the fund.
    if (!emp.release_sent) {
      out.risk = { level: 'release_due', label: 'טופס שחרור (161) לקרן טרם נשלח', deadline: emp.termination_date };
    } else {
      out.risk = { level: 'ok', label: 'הסתיים — שחרור נשלח' };
    }
    return out;
  }

  if (emp.pension_opened) {
    out.risk = { level: 'ok', label: 'תיק פנסיה נפתח' };
    return out;
  }

  const daysLeft = daysBetween(todayIso, deadline);
  if (daysLeft < 0) {
    out.risk = { level: 'overdue', label: `חריגה בחוק — עברו ${-daysLeft} ימים מהמועד`, deadline };
  } else if (daysLeft <= config.pension.warnDays) {
    out.risk = { level: 'due_soon', label: `לפתוח תיק תוך ${daysLeft} ימים`, deadline };
  } else {
    out.risk = { level: 'ok', label: `מועד פתיחה: ${deadline}`, deadline };
  }
  return out;
}

const SELECT_JOINED = `
  SELECT e.*, c.name AS company_name, st.name AS store_name
    FROM employees e
    LEFT JOIN companies c ON c.id = e.company_id
    LEFT JOIN stores st ON st.id = e.store_id`;

export async function listEmployees({ status = null } = {}, todayIso = today(), x = getExecutor()) {
  const clause = status ? ' WHERE e.status = ?' : '';
  const rows = await x.many(`${SELECT_JOINED}${clause} ORDER BY e.status, e.start_date DESC, e.id DESC`, status ? [status] : []);
  return rows.map((r) => assess(r, todayIso));
}

export async function getEmployee(id, todayIso = today(), x = getExecutor()) {
  const row = await x.one(`${SELECT_JOINED} WHERE e.id = ?`, [id]);
  if (!row) throw new NotFoundError(`עובד ${id} לא נמצא`);
  return assess(row, todayIso);
}

export async function createEmployee(
  { name, companyId = null, storeId = null, startDate, priorPension = false, notes = null },
  actor,
  x = getExecutor(),
) {
  const n = (name ?? '').trim();
  if (!n) throw new RuleError('VALIDATION', 'שם עובד חובה');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '')) throw new RuleError('VALIDATION', 'תאריך תחילת עבודה חובה');
  const info = await x.run(
    `INSERT INTO employees (name, company_id, store_id, start_date, prior_pension, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [n, companyId ? Number(companyId) : null, storeId ? Number(storeId) : null, startDate, priorPension ? 1 : 0, notes?.trim() || null, actor.id],
  );
  await logAction({ userId: actor.id, action: 'employee.create', entityType: 'employee', entityId: info.lastInsertRowid, details: { name: n } }, x);
  return getEmployee(info.lastInsertRowid, today(), x);
}

/** Mark the pension file opened (clears the open-on-time obligation). */
export async function setPensionOpened(id, date, actor, x = getExecutor()) {
  await getEmployee(id, today(), x);
  await x.run('UPDATE employees SET pension_opened = 1, pension_opened_date = ? WHERE id = ?', [
    date || today(),
    id,
  ]);
  await logAction({ userId: actor.id, action: 'employee.pension_opened', entityType: 'employee', entityId: id }, x);
  return getEmployee(id, today(), x);
}

/** Record a termination (resigned/dismissed) — opens the release-notice obligation. */
export async function terminateEmployee(id, { date, reason }, actor, x = getExecutor()) {
  const emp = await getEmployee(id, today(), x);
  if (emp.status === 'terminated') return emp;
  if (!['resigned', 'dismissed'].includes(reason)) throw new RuleError('VALIDATION', 'סיבת סיום חובה (התפטרות/פיטורים)');
  await x.run(
    "UPDATE employees SET status = 'terminated', termination_date = ?, termination_reason = ? WHERE id = ?",
    [date || today(), reason, id],
  );
  await logAction({ userId: actor.id, action: 'employee.terminate', entityType: 'employee', entityId: id, details: { reason } }, x);
  return getEmployee(id, today(), x);
}

/** Mark the release notice (טופס 161) to the fund as sent. */
export async function markReleaseSent(id, date, actor, x = getExecutor()) {
  const emp = await getEmployee(id, today(), x);
  if (emp.status !== 'terminated') throw new RuleError('STATE', 'ניתן לסמן שחרור רק לעובד שסיים.');
  await x.run('UPDATE employees SET release_sent = 1, release_sent_date = ? WHERE id = ?', [date || today(), id]);
  await logAction({ userId: actor.id, action: 'employee.release_sent', entityType: 'employee', entityId: id }, x);
  return getEmployee(id, today(), x);
}

/** Employees currently in a legal-risk state (overdue open, due soon, or release pending). */
export async function pensionAlerts(todayIso = today(), x = getExecutor()) {
  const all = await listEmployees({}, todayIso, x);
  return all.filter((e) => e.risk && e.risk.level !== 'ok');
}

/** Counts for the dashboard/pension header. */
export async function pensionSummary(todayIso = today(), x = getExecutor()) {
  const all = await listEmployees({}, todayIso, x);
  const active = all.filter((e) => e.status === 'active').length;
  const overdue = all.filter((e) => e.risk?.level === 'overdue').length;
  const dueSoon = all.filter((e) => e.risk?.level === 'due_soon').length;
  const releaseDue = all.filter((e) => e.risk?.level === 'release_due').length;
  return { active, overdue, dueSoon, releaseDue, atRisk: overdue + dueSoon + releaseDue };
}
