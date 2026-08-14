import { getExecutor, tx } from '../db/adapter.js';
import { RuleError, NotFoundError } from '../lib/errors.js';
import { fromAgorot } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { scopeClause } from '../lib/scope.js';
import { logAction } from './audit.js';
import { EXPENSE_KINDS } from './zreports.js';

// A shortage bigger than this (agorot) triggers a Telegram push to the owner.
const SHORTAGE_ALERT_AGOROT = 2000; // ₪20

// "סגירת Z" — a register-closer's end-of-shift count. Denomination counts → cash total, plus
// itemized expenses → expenses total, and a grand total (cash + expenses). Times are recorded in
// Israel local time. This module is intentionally self-contained: the register-closer role can
// reach ONLY this feature (enforced by the page firewall), so nothing here reads other entities.

// Israeli shekel denominations: bills then coins/agorot. value in shekels, key is form-safe.
export const CLOSING_DENOMS = [
  { value: 200, key: '200', kind: 'שטר' },
  { value: 100, key: '100', kind: 'שטר' },
  { value: 50, key: '50', kind: 'שטר' },
  { value: 20, key: '20', kind: 'שטר' },
  { value: 10, key: '10', kind: 'מטבע' },
  { value: 5, key: '5', kind: 'מטבע' },
  { value: 2, key: '2', kind: 'מטבע' },
  { value: 1, key: '1', kind: 'מטבע' },
  { value: 0.5, key: '0_5', kind: 'מטבע' },
  { value: 0.1, key: '0_1', kind: 'מטבע' },
];

const AGOROT = (shekels) => Math.round(shekels * 100);

/** Current date+time in Israel, formatted 'YYYY-MM-DD HH:MM' (24h, Asia/Jerusalem). */
export function israelNow() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Normalize the itemized cash-expense rows — same shape/rules as z reports' replaceExpenses.
// Each row: { kind, expenseDate, payerName, purpose, employeeId, invoiceId, amount(agorot) }.
// Only one of employee/invoice is kept, per the row's kind. Empty rows are dropped.
function normalizeExpenses(rows) {
  return (rows || [])
    .map((r) => {
      let kind = EXPENSE_KINDS.has(r.kind) ? r.kind : null;
      if (!kind) kind = r.invoiceId ? 'invoice' : 'manual';
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
}

// Validate + recompute a closing's fields from raw input. Totals are always derived server-side
// (never trusted from the client). Shared by create and update.
function computeClosing(input) {
  const first = (input.employeeFirst || '').trim();
  const last = (input.employeeLast || '').trim();
  const employeeId = input.employeeId ? Number(input.employeeId) : null;
  if (!employeeId && (!first || !last)) throw new RuleError('VALIDATION', 'יש לבחור עובד (או להזין שם)');
  const zNumber = (input.zNumber || '').trim();
  if (!zNumber) throw new RuleError('VALIDATION', 'יש להזין מספר Z');
  const drawerCash = Number.isFinite(input.drawerCash) ? input.drawerCash : 0;
  if (drawerCash < 0) throw new RuleError('VALIDATION', 'סה"כ מזומן מגירה חייב להיות מספר לא-שלילי');
  const storeId = input.storeId ? Number(input.storeId) : null;

  const breakdown = {};
  let totalCash = 0;
  for (const d of CLOSING_DENOMS) {
    const c = Math.max(0, Math.floor(Number(input.counts?.[d.key]) || 0));
    if (c > 0) breakdown[d.key] = c;
    totalCash += AGOROT(d.value) * c;
  }

  const expenses = normalizeExpenses(input.expenses);
  for (const e of expenses) {
    if (e.amount < 0) throw new RuleError('VALIDATION', 'סכום הוצאה חייב להיות מספר לא-שלילי');
  }
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  return { first, last, employeeId, zNumber, drawerCash, storeId, breakdown, totalCash, expenses, totalExpenses, grandTotal: totalCash + totalExpenses };
}

// The employee's stored display names — set from the picked employee when one is chosen, so all
// existing display/notify code (employee_first/employee_last) keeps working.
async function resolveEmployeeNames(employeeId, fallbackFirst, fallbackLast, x) {
  if (!employeeId) return { first: fallbackFirst, last: fallbackLast };
  const emp = await x.one('SELECT first_name, last_name FROM employees WHERE id = ?', [employeeId]);
  if (!emp) throw new RuleError('VALIDATION', 'העובד שנבחר לא נמצא');
  return { first: emp.first_name, last: emp.last_name };
}

// Insert the itemized cash-expense rows for a closing (inside an open transaction executor `t`).
async function insertExpenses(t, closingId, expenses) {
  for (const r of expenses) {
    await t.run(
      `INSERT INTO z_closing_expenses (closing_id, expense_date, payer_name, purpose, description_type, employee_id, invoice_id, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [closingId, r.expenseDate, r.payerName, r.purpose, r.kind, r.employeeId, r.invoiceId, r.amount],
    );
  }
}

/**
 * Save a register closing. Totals are recomputed server-side from the counts/expenses (never
 * trusted from the client). ended_at is stamped in Israel time here; started_at is passed in.
 * @param {{employeeFirst, employeeLast, startedAt, counts:{[key]:number},
 *   expenses:Array<{desc:string, amount:number}>}} input  amounts in agorot
 */
export async function createZClosing(input, actor, x = getExecutor()) {
  const { first, last, employeeId, zNumber, drawerCash, storeId, breakdown, totalCash, expenses, totalExpenses, grandTotal } = computeClosing(input);
  const names = await resolveEmployeeNames(employeeId, first, last, x);

  const info = await tx(async (t) => {
    const r = await t.run(
      `INSERT INTO z_closings
         (employee_first, employee_last, employee_id, store_id, z_number, drawer_cash, started_at, ended_at, breakdown, total_cash, expenses, total_expenses, grand_total, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [names.first, names.last, employeeId, storeId, zNumber, drawerCash, input.startedAt || null, israelNow(), JSON.stringify(breakdown), totalCash, JSON.stringify(expenses), totalExpenses, grandTotal, actor?.id ?? null],
    );
    await insertExpenses(t, r.lastInsertRowid, expenses);
    return r;
  });
  await logAction(
    { userId: actor?.id ?? null, action: 'zclosing.create', entityType: 'z_closing', entityId: info.lastInsertRowid, details: { employee: `${names.first} ${names.last}`, grandTotal } },
    x,
  );

  // חוסר/יתרה vs the declared drawer cash. A shortage over ₪20 pushes an alert to the owner.
  const diff = grandTotal - drawerCash; // >0 יתרה · <0 חוסר
  if (diff < 0 && Math.abs(diff) > SHORTAGE_ALERT_AGOROT) {
    let storeName = '';
    if (storeId) {
      const s = await x.one('SELECT name FROM stores WHERE id = ?', [storeId]);
      storeName = s ? s.name : '';
    }
    notify(
      `⚠️ <b>חוסר בסגירת קופה</b>\nעובד: ${names.first} ${names.last}` +
        (storeName ? `\nחנות: ${storeName}` : '') +
        `\nZ ${zNumber}\nחוסר ע"ס ₪${fromAgorot(Math.abs(diff))}\n(נספר ₪${fromAgorot(grandTotal)} מול מגירה ₪${fromAgorot(drawerCash)})`,
    );
  }
  return info.lastInsertRowid;
}

/** The most recent Z closing matching a store + Z number (for bill reconciliation on the Z report). */
export async function matchingClosing(storeId, zNumber, x = getExecutor()) {
  if (!storeId || !zNumber) return null;
  return x.one(
    'SELECT * FROM z_closings WHERE store_id = ? AND z_number = ? ORDER BY id DESC LIMIT 1',
    [Number(storeId), String(zNumber).trim()],
  );
}

/** Recent closings, newest first, with the store name for display. */
export async function listZClosings({ limit = 30 } = {}, x = getExecutor()) {
  return x.many(
    `SELECT zc.*, st.name AS store_name
       FROM z_closings zc
       LEFT JOIN stores st ON st.id = zc.store_id
      ORDER BY zc.id DESC LIMIT ?`,
    [limit],
  );
}

/** A single closing (with store name). Throws NotFoundError if it doesn't exist. */
export async function getZClosing(id, x = getExecutor()) {
  const row = await x.one(
    `SELECT zc.*, st.name AS store_name FROM z_closings zc LEFT JOIN stores st ON st.id = zc.store_id WHERE zc.id = ?`,
    [id],
  );
  if (!row) throw new NotFoundError(`סגירת Z ${id} לא נמצאה`);
  return row;
}

/**
 * The itemized cash-expense lines of a closing, joined for display (invoice number/supplier,
 * employee name). Ordered by id. Empty when the closing has no cash expenses.
 */
export async function listClosingExpenses(closingId, x = getExecutor()) {
  return x.many(
    `SELECT e.*, i.invoice_number, i.total_amount AS invoice_total, s.name AS invoice_supplier,
            emp.first_name AS emp_first, emp.last_name AS emp_last
       FROM z_closing_expenses e
       LEFT JOIN invoices i ON i.id = e.invoice_id
       LEFT JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN employees emp ON emp.id = e.employee_id
      WHERE e.closing_id = ? ORDER BY e.id`,
    [closingId],
  );
}

/**
 * Recent cash expenses across register closings, newest first, joined for display and scoped to
 * the caller's companies (null scope = owner/all). Feeds the "הוצאות מזומן" rubric shown above the
 * closings list and at the top of the invoices page.
 */
export async function recentClosingExpenses(scope = null, limit = 30, x = getExecutor()) {
  const sc = scopeClause(scope, 'st.company_id');
  return x.many(
    `SELECT e.id, e.expense_date, e.payer_name, e.purpose, e.description_type, e.amount,
            e.invoice_id, i.invoice_number, s.name AS invoice_supplier,
            emp.first_name AS emp_first, emp.last_name AS emp_last,
            zc.id AS closing_id, zc.z_number, st.name AS store_name
       FROM z_closing_expenses e
       JOIN z_closings zc ON zc.id = e.closing_id
       LEFT JOIN stores st ON st.id = zc.store_id
       LEFT JOIN invoices i ON i.id = e.invoice_id
       LEFT JOIN suppliers s ON s.id = i.supplier_id
       LEFT JOIN employees emp ON emp.id = e.employee_id
      WHERE e.amount > 0${sc.sql}
      ORDER BY e.expense_date DESC, e.id DESC LIMIT ?`,
    [...sc.params, limit],
  );
}

/** Edit an existing closing — recomputes all totals server-side, same validation as create. */
export async function updateZClosing(id, input, actor, x = getExecutor()) {
  await getZClosing(id, x);
  const { first, last, employeeId, zNumber, drawerCash, storeId, breakdown, totalCash, expenses, totalExpenses, grandTotal } = computeClosing(input);
  const names = await resolveEmployeeNames(employeeId, first, last, x);
  await tx(async (t) => {
    await t.run(
      `UPDATE z_closings SET employee_first = ?, employee_last = ?, employee_id = ?, store_id = ?, z_number = ?, drawer_cash = ?,
         breakdown = ?, total_cash = ?, expenses = ?, total_expenses = ?, grand_total = ? WHERE id = ?`,
      [names.first, names.last, employeeId, storeId, zNumber, drawerCash, JSON.stringify(breakdown), totalCash, JSON.stringify(expenses), totalExpenses, grandTotal, id],
    );
    await t.run('DELETE FROM z_closing_expenses WHERE closing_id = ?', [id]);
    await insertExpenses(t, id, expenses);
  });
  await logAction({ userId: actor?.id ?? null, action: 'zclosing.update', entityType: 'z_closing', entityId: id }, x);
  return getZClosing(id, x);
}

export async function deleteZClosing(id, actor, x = getExecutor()) {
  await getZClosing(id, x);
  // Child expense rows cascade on FK; delete explicitly too so it works if FKs are off.
  await tx(async (t) => {
    await t.run('DELETE FROM z_closing_expenses WHERE closing_id = ?', [id]);
    await t.run('DELETE FROM z_closings WHERE id = ?', [id]);
  });
  await logAction({ userId: actor?.id ?? null, action: 'zclosing.delete', entityType: 'z_closing', entityId: id }, x);
}
