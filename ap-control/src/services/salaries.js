import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError, AuthError } from '../lib/errors.js';
import { toAgorot } from '../lib/money.js';
import { logAction } from './audit.js';

// Employee wage payments (משכורות) — ROADMAP §D. Recorded like a payment (method + reference +
// amount + date) but deliberately OUTSIDE the invoice/AP control flow: salaries are not backed
// by a supplier invoice and never gate a check (R1/R5).

const METHODS = new Set(['check', 'transfer', 'cash']);

const SELECT_JOINED = `
  SELECT sal.*, ba.display_name AS account_name
    FROM salaries sal
    LEFT JOIN bank_accounts ba ON ba.id = sal.bank_account_id`;

/** List salary payments, newest first, optionally filtered by date range and/or employee name. */
export async function listSalaries({ from = null, to = null, employee = null } = {}, x = getExecutor()) {
  const where = [];
  const params = [];
  if (from) { where.push('sal.pay_date >= ?'); params.push(from); }
  if (to) { where.push('sal.pay_date <= ?'); params.push(to); }
  if (employee) { where.push('sal.employee_name LIKE ?'); params.push(`%${employee}%`); }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  return x.many(`${SELECT_JOINED}${clause} ORDER BY sal.pay_date DESC, sal.id DESC`, params);
}

export async function getSalary(id, x = getExecutor()) {
  const row = await x.one(`${SELECT_JOINED} WHERE sal.id = ?`, [id]);
  if (!row) throw new NotFoundError(`רישום שכר ${id} לא נמצא`);
  return row;
}

/** Record a salary payment. Amount is entered in shekels, stored as agorot. */
export async function createSalary(
  { employeeName, bankAccountId = null, method = 'transfer', reference = null, amount, payDate, period = null, notes = null },
  actor,
  x = getExecutor(),
) {
  const name = (employeeName ?? '').trim();
  if (!name) throw new RuleError('VALIDATION', 'שם עובד חובה');
  if (!payDate) throw new RuleError('VALIDATION', 'תאריך תשלום חובה');
  if (!METHODS.has(method)) method = 'transfer';
  const amountAgorot = toAgorot(amount);
  if (amountAgorot <= 0) throw new RuleError('VALIDATION', 'סכום השכר חייב להיות חיובי');
  // Cash has no bank account; check/transfer reference their account.
  const acct = method === 'cash' ? null : bankAccountId ? Number(bankAccountId) : null;

  const info = await x.run(
    `INSERT INTO salaries (employee_name, bank_account_id, method, reference, amount, pay_date, period, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, acct, method, reference?.trim() || null, amountAgorot, payDate, period?.trim() || null, notes?.trim() || null, actor.id],
  );
  await logAction(
    { userId: actor.id, action: 'salary.create', entityType: 'salary', entityId: info.lastInsertRowid, details: { name, amount: amountAgorot, method } },
    x,
  );
  return getSalary(info.lastInsertRowid, x);
}

/** Delete a salary record — owner only (correcting a mistaken entry). */
export async function deleteSalary(id, actor, x = getExecutor()) {
  if (!actor || actor.role !== 'owner') throw new AuthError('מחיקת רישום שכר — בעלים בלבד');
  await getSalary(id, x);
  await x.run('DELETE FROM salaries WHERE id = ?', [id]);
  await logAction({ userId: actor.id, action: 'salary.delete', entityType: 'salary', entityId: id }, x);
}

/** Total paid + count for the current filter (for the report header). */
export async function salariesTotal({ from = null, to = null, employee = null } = {}, x = getExecutor()) {
  const rows = await listSalaries({ from, to, employee }, x);
  return { count: rows.length, total: rows.reduce((s, r) => s + r.amount, 0) };
}
