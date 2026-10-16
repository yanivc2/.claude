import { getExecutor, tx } from '../db/adapter.js';
import { RuleError, NotFoundError } from '../lib/errors.js';
import { fromAgorot } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { scopeClause, scopeWhere } from '../lib/scope.js';
import { logAction } from './audit.js';
import { EXPENSE_KINDS } from './zreports.js';
import { parseInvoiceIds, encodeInvoiceIds, cashExpenseInvoiceIdsReady } from './cashExpenseInvoices.js';

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
      // שורה אחת יכולה לשלם כמה חשבוניות ("12,15"): invoice_id = הראשונה, invoiceIds = כולן.
      const invoiceIds = kind === 'invoice' ? parseInvoiceIds(r.invoiceIds ?? r.invoiceId) : [];
      const invoiceId = invoiceIds[0] || null;
      const employeeId = (kind === 'salary' || kind === 'advance') && r.employeeId ? Number(r.employeeId) : null;
      return {
        expenseDate: r.expenseDate || null,
        payerName: (r.payerName || '').trim() || null,
        purpose: (r.purpose || '').trim() || null,
        kind,
        employeeId,
        amount: Number.isFinite(r.amount) ? r.amount : 0,
        invoiceId,
        invoiceIds,
        rowId: Number(r.rowId) || null,
      };
    })
    .filter((r) => r.amount > 0 || r.payerName || r.purpose || r.invoiceId || r.employeeId);
}
// עותק ה-JSON שעל הסגירה (`z_closings.expenses`) — בלי מזהה השורה, שהוא של הטופס ולא של הנתון.
const expensesJson = (list) => JSON.stringify(list.map(({ rowId, ...e }) => e));

// Per-register cash balancing counted before the Z. Each register: which register (קופה), which
// store, and a denomination breakdown → total (all agorot, computed server-side). Independent of
// the main drawer count. Empty registers are dropped.
//
// The COUNTER is the closing's employee — the form no longer asks for a name per register (it was
// the same person typed twice). `first`/`last` stay on the row because saved closings carry them
// and they are what any display reads; `stampRegisterCounter` fills them in from the closing's
// employee once it is resolved, and a legacy row that already has its own name keeps it.
function normalizeRegisters(rows) {
  return (rows || [])
    .map((r) => {
      const breakdown = {};
      let total = 0;
      for (const d of CLOSING_DENOMS) {
        const c = Math.max(0, Math.floor(Number(r.counts?.[d.key]) || 0));
        if (c > 0) breakdown[d.key] = c;
        total += AGOROT(d.value) * c;
      }
      return {
        first: (r.first || '').trim(),
        last: (r.last || '').trim(),
        register: (r.register ?? '').toString().trim(),
        storeId: r.storeId ? Number(r.storeId) : null,
        breakdown,
        total,
      };
    })
    .filter((r) => r.first || r.last || r.register || r.total > 0);
}

/** Give every register the closing's counter, unless it carries a name of its own (legacy rows). */
function stampRegisterCounter(registers, names) {
  return registers.map((r) => (r.first || r.last ? r : { ...r, first: names.first, last: names.last }));
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
  const registers = normalizeRegisters(input.registers);
  return { first, last, employeeId, zNumber, drawerCash, storeId, breakdown, totalCash, expenses, totalExpenses, registers, grandTotal: totalCash + totalExpenses };
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
// `withIds` = the invoice_ids column exists (probed BEFORE the transaction — see cashExpenseInvoices.js).
async function insertExpenses(t, closingId, expenses, withIds = false) {
  for (const r of expenses) {
    if (withIds) {
      await t.run(
        `INSERT INTO z_closing_expenses (closing_id, expense_date, payer_name, purpose, description_type, employee_id, invoice_id, invoice_ids, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [closingId, r.expenseDate, r.payerName, r.purpose, r.kind, r.employeeId, r.invoiceId, encodeInvoiceIds(r.invoiceIds), r.amount],
      );
    } else {
      await t.run(
        `INSERT INTO z_closing_expenses (closing_id, expense_date, payer_name, purpose, description_type, employee_id, invoice_id, amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [closingId, r.expenseDate, r.payerName, r.purpose, r.kind, r.employeeId, r.invoiceId, r.amount],
      );
    }
  }
}

// 🔴 עריכת סגירה מעדכנת שורה קיימת **במקומה** (לפי `expense_row_id` מהטופס) ולא מוחקת ויוצרת הכל:
// במחיקה-ויצירה כל מה שתלוי במזהה השורה אבד בכל שמירה — "✓ טופל", קישור צ׳ק שכר
// (`salary_payments.cash_expense_id`) וצ׳ק שבוטל בגלל פריטה (`payments.void_cash_expense_id`), שניהם
// ON DELETE SET NULL. שורה בלי מזהה נוספת; שורה קיימת שלא הוחזרה נמחקת.
async function saveClosingExpenses(t, closingId, expenses, withIds) {
  const existing = new Set((await t.many('SELECT id FROM z_closing_expenses WHERE closing_id = ?', [closingId])).map((e) => Number(e.id)));
  const kept = new Set();
  const fresh = [];
  for (const r of expenses) {
    if (!r.rowId || !existing.has(r.rowId) || kept.has(r.rowId)) { fresh.push(r); continue; }
    kept.add(r.rowId);
    if (withIds) {
      await t.run(
        `UPDATE z_closing_expenses SET expense_date = ?, payer_name = ?, purpose = ?, description_type = ?, employee_id = ?, invoice_id = ?, invoice_ids = ?, amount = ?
          WHERE id = ? AND closing_id = ?`,
        [r.expenseDate, r.payerName, r.purpose, r.kind, r.employeeId, r.invoiceId, encodeInvoiceIds(r.invoiceIds), r.amount, r.rowId, closingId],
      );
    } else {
      await t.run(
        `UPDATE z_closing_expenses SET expense_date = ?, payer_name = ?, purpose = ?, description_type = ?, employee_id = ?, invoice_id = ?, amount = ?
          WHERE id = ? AND closing_id = ?`,
        [r.expenseDate, r.payerName, r.purpose, r.kind, r.employeeId, r.invoiceId, r.amount, r.rowId, closingId],
      );
    }
  }
  for (const eid of existing) if (!kept.has(eid)) await t.run('DELETE FROM z_closing_expenses WHERE id = ?', [eid]);
  await insertExpenses(t, closingId, fresh, withIds);
}

// 🔴 שמירה כפולה (בעלים, 13/10: אותה סגירת Z נשמרה 4 פעמים באותה דקה — לחיצות חוזרות כשהשמירה
// הייתה איטית). הטופס חוסם לחיצה שנייה (data-busy ב-footer), וזו השכבה השנייה: אותה סגירה בדיוק —
// חנות, Z, עובד, מגירה, סכומים ושורות הוצאה — שכבר נשמרה ב-15 הדקות האחרונות לא נשמרת שוב.
// סגירה שונה (סכום אחר, שורה אחרת) נשמרת כרגיל; תיקון של סגירה קיימת נעשה בעריכה.
export const DUPLICATE_CLOSING_WINDOW_SEC = 15 * 60;
export async function findRecentDuplicateClosing(input, x = getExecutor()) {
  const c = computeClosing(input);
  const names = await resolveEmployeeNames(c.employeeId, c.first, c.last, x);
  const rows = await x.many(
    c.zNumber == null || c.zNumber === ''
      ? 'SELECT * FROM z_closings WHERE z_number IS NULL'
      : 'SELECT * FROM z_closings WHERE z_number = ?',
    c.zNumber == null || c.zNumber === '' ? [] : [c.zNumber],
  );
  const now = Date.now();
  const same = (a, b) => (a == null ? null : Number(a)) === (b == null ? null : Number(b));
  const hit = rows.find((r) => {
    const at = Date.parse(`${String(r.created_at || '').replace(' ', 'T')}Z`);
    return Number.isFinite(at) && now - at <= DUPLICATE_CLOSING_WINDOW_SEC * 1000
      && same(r.store_id, c.storeId)
      && String(r.employee_first || '') === String(names.first || '')
      && String(r.employee_last || '') === String(names.last || '')
      && same(r.drawer_cash, c.drawerCash) && same(r.grand_total, c.grandTotal) && same(r.total_expenses, c.totalExpenses)
      && String(r.expenses || '') === expensesJson(c.expenses);
  });
  return hit ? Number(hit.id) : null;
}

/**
 * Save a register closing. Totals are recomputed server-side from the counts/expenses (never
 * trusted from the client). ended_at is stamped in Israel time here; started_at is passed in.
 * @param {{employeeFirst, employeeLast, startedAt, counts:{[key]:number},
 *   expenses:Array<{desc:string, amount:number}>}} input  amounts in agorot
 */
export async function createZClosing(input, actor, x = getExecutor()) {
  const { first, last, employeeId, zNumber, drawerCash, storeId, breakdown, totalCash, expenses, totalExpenses, registers, grandTotal } = computeClosing(input);
  // אותה סגירה שכבר נשמרה הרגע — מחזירים אותה במקום עותק נוסף (וגם בלי התראת "חוסר" שנייה).
  const dupId = await findRecentDuplicateClosing(input, x);
  if (dupId) {
    await logAction({ userId: actor?.id ?? null, action: 'zclosing.duplicate_ignored', entityType: 'z_closing', entityId: dupId }, x);
    return dupId;
  }
  const names = await resolveEmployeeNames(employeeId, first, last, x);
  const regs = stampRegisterCounter(registers, names);
  const withIds = await cashExpenseInvoiceIdsReady(x);

  const info = await tx(async (t) => {
    const r = await t.run(
      `INSERT INTO z_closings
         (employee_first, employee_last, employee_id, store_id, z_number, drawer_cash, started_at, ended_at, breakdown, total_cash, expenses, total_expenses, grand_total, registers, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [names.first, names.last, employeeId, storeId, zNumber, drawerCash, input.startedAt || null, israelNow(), JSON.stringify(breakdown), totalCash, expensesJson(expenses), totalExpenses, grandTotal, JSON.stringify(regs), actor?.id ?? null],
    );
    await insertExpenses(t, r.lastInsertRowid, expenses, withIds);
    return r;
  });
  await logAction(
    { userId: actor?.id ?? null, action: 'zclosing.create', entityType: 'z_closing', entityId: info.lastInsertRowid, details: { employee: `${names.first} ${names.last}`, grandTotal } },
    x,
  );

  // חוסר/יתרה — אותו ביטוי בדיוק של עמודת "חוסר / יתרה" ושל הטופס (closingDiff). חוסר מעל ₪20 → התראה.
  const diff = closingDiff({ drawerCash, grandTotal });
  if (diff < 0 && Math.abs(diff) > SHORTAGE_ALERT_AGOROT) {
    let storeName = '';
    if (storeId) {
      const s = await x.one('SELECT name FROM stores WHERE id = ?', [storeId]);
      storeName = s ? s.name : '';
    }
    await notify( // await: על serverless התראה בלי await נעלמת כשהתשובה כבר נשלחה (CLAUDE.md)
      `⚠️ <b>חוסר בסגירת קופה</b>\nעובד: ${names.first} ${names.last}` +
        (storeName ? `\nחנות: ${storeName}` : '') +
        `\nZ ${zNumber}\nחוסר ע"ס ₪${fromAgorot(Math.abs(diff))}\n(נספר+הוצאות ₪${fromAgorot(grandTotal)} מול מגירה ₪${fromAgorot(drawerCash)})`,
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
export async function listZClosings({ limit = 30, scope = null } = {}, x = getExecutor()) {
  // Scoped: a register closing belongs to a store, and a user granted one store must not see
  // another store's cash count. A closing with no store (legacy rows) stays visible — it is not
  // bound to any store, so there is nothing to separate.
  const sc = scopeWhere(scope, 'st.company_id', 'zc.store_id');
  const guard = sc.sql ? ` WHERE zc.store_id IS NULL OR (1 = 1${sc.sql})` : '';
  return x.many(
    `SELECT zc.*, st.name AS store_name
       FROM z_closings zc
       LEFT JOIN stores st ON st.id = zc.store_id${guard}
      ORDER BY zc.id DESC LIMIT ?`,
    [...sc.params, limit],
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
  const sc = scopeWhere(scope, 'st.company_id', 'st.id');
  const withIds = await cashExpenseInvoiceIdsReady(x);
  return x.many(
    `SELECT e.id, e.expense_date, e.payer_name, e.purpose, e.description_type, e.amount,
            e.invoice_id,${withIds ? ' e.invoice_ids,' : ''} i.invoice_number, s.name AS invoice_supplier,
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

/**
 * Match a register-closing cash expense to an invoice → the invoice reads "שולם במזומן". Returns the
 * expense's company_id so the caller can scope-check it. Idempotent per (expense).
 */
export async function matchClosingExpenseToInvoice(expenseId, invoiceId, actor, scopeCompanyIds = null, x = getExecutor()) {
  const exp = await x.one(
    `SELECT e.id, zc.store_id, st.company_id
       FROM z_closing_expenses e JOIN z_closings zc ON zc.id = e.closing_id
       LEFT JOIN stores st ON st.id = zc.store_id WHERE e.id = ?`,
    [expenseId],
  );
  if (!exp) throw new NotFoundError(`הוצאת מזומן ${expenseId} לא נמצאה`);
  // Scope-check the expense side BEFORE mutating (the invoice side is checked by the route).
  if (scopeCompanyIds !== null && exp.company_id != null && !scopeCompanyIds.includes(Number(exp.company_id))) {
    throw new RuleError('SCOPE', 'אין הרשאה להוצאה זו');
  }
  const inv = await x.one('SELECT id FROM invoices WHERE id = ?', [invoiceId]);
  if (!inv) throw new NotFoundError(`חשבונית ${invoiceId} לא נמצאה`);
  if (await cashExpenseInvoiceIdsReady(x)) {
    await x.run(
      "UPDATE z_closing_expenses SET invoice_id = ?, invoice_ids = ?, description_type = 'invoice' WHERE id = ?",
      [invoiceId, encodeInvoiceIds([invoiceId]), expenseId],
    );
  } else {
    await x.run(
      "UPDATE z_closing_expenses SET invoice_id = ?, description_type = 'invoice' WHERE id = ?",
      [invoiceId, expenseId],
    );
  }
  await logAction(
    { userId: actor?.id ?? null, action: 'zclosing.match_cash', entityType: 'invoice', entityId: invoiceId, details: { expenseId } },
    x,
  );
  return { companyId: exp.company_id == null ? null : Number(exp.company_id) };
}

/** Undo a cash-expense↔invoice match (back to a plain manual expense). */
export async function unmatchClosingExpense(expenseId, actor, x = getExecutor()) {
  await x.run(
    (await cashExpenseInvoiceIdsReady(x))
      ? "UPDATE z_closing_expenses SET invoice_id = NULL, invoice_ids = NULL, description_type = 'manual' WHERE id = ?"
      : "UPDATE z_closing_expenses SET invoice_id = NULL, description_type = 'manual' WHERE id = ?",
    [expenseId],
  );
  await logAction({ userId: actor?.id ?? null, action: 'zclosing.unmatch_cash', entityType: 'z_closing_expense', entityId: expenseId }, x);
}

/** Edit an existing closing — recomputes all totals server-side, same validation as create. */
export async function updateZClosing(id, input, actor, x = getExecutor()) {
  await getZClosing(id, x);
  const { first, last, employeeId, zNumber, drawerCash, storeId, breakdown, totalCash, expenses, totalExpenses, registers, grandTotal } = computeClosing(input);
  const names = await resolveEmployeeNames(employeeId, first, last, x);
  const regs = stampRegisterCounter(registers, names);
  const withIds = await cashExpenseInvoiceIdsReady(x);
  await tx(async (t) => {
    await t.run(
      `UPDATE z_closings SET employee_first = ?, employee_last = ?, employee_id = ?, store_id = ?, z_number = ?, drawer_cash = ?,
         breakdown = ?, total_cash = ?, expenses = ?, total_expenses = ?, grand_total = ?, registers = ? WHERE id = ?`,
      [names.first, names.last, employeeId, storeId, zNumber, drawerCash, JSON.stringify(breakdown), totalCash, expensesJson(expenses), totalExpenses, grandTotal, JSON.stringify(regs), id],
    );
    await saveClosingExpenses(t, id, expenses, withIds);
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

/**
 * חוסר / יתרה של סגירת Z = **(נספר + הוצאות) − מגירה** — הדוגמה של הבעלים: מגירה 1,000, נספר +
 * הוצאות 950 → **‎-50** (חסר כסף ביחס למגירה). ביטוי יחיד: עמודת "חוסר / יתרה" בסגירות האחרונות
 * (מספר עם סימן), השורה בטופס (index/edit) וההתראה על חוסר.
 * @returns {number} agorot — <0 חוסר · >0 יתרה · 0 תואם
 */
export function closingDiff({ drawerCash, grandTotal }) {
  return (Number(grandTotal) || 0) - (Number(drawerCash) || 0);
}
