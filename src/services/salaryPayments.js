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
import { notify } from '../lib/notify.js';
import { fromAgorot } from '../lib/money.js';
import { plainNumber } from '../lib/numText.js';

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
  const rows = await x.many(
    `SELECT sp.*, e.first_name, e.last_name, st.name AS store_name
       FROM salary_payments sp
       JOIN employees e ON e.id = sp.employee_id
       JOIN stores st ON st.id = sp.store_id
      WHERE 1 = 1${sc.sql}${filter}
      ORDER BY sp.due_date DESC, sp.id DESC LIMIT ?`,
    params,
  );
  // תאריך הפירעון בבנק (צ׳ק ששויך לתנועת הבנק שלו). שאילתה נפרדת ולא JOIN רביעי — pg-mem מתקשה
  // בחיפוש לפי מזהה על טבלה מצורפת (ראה lib/scope.js#scopeClause), והרשימה קצרה וחסומה.
  const linked = rows.filter((r) => r.bank_txn_id != null).map((r) => Number(r.bank_txn_id));
  if (linked.length) {
    const txns = await x.many(
      `SELECT id, txn_date FROM bank_transactions WHERE id IN (${linked.map(() => '?').join(',')})`,
      linked,
    );
    const dateOf = new Map(txns.map((t) => [Number(t.id), t.txn_date]));
    for (const r of rows) if (r.bank_txn_id != null) r.bank_date = dateOf.get(Number(r.bank_txn_id)) || null;
  }
  return rows;
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
export async function markCashed(id, cashExpenseId, actor, x = getExecutor(), { source = 'zclosing' } = {}) {
  if (source !== 'zclosing' && source !== 'zreport') throw new RuleError('VALIDATION', 'מקור הוצאה לא מוכר');
  const row = await getSalaryPayment(id, x);
  if (Number(row.cashed)) throw new RuleError('R', 'תשלום השכר כבר סומן כנפרט');
  if (row.bank_txn_id) {
    const bt = await x.one('SELECT txn_date FROM bank_transactions WHERE id = ?', [row.bank_txn_id]);
    throw new RuleError('R', `הצ׳ק כבר נפרע בבנק${bt ? ` (${bt.txn_date})` : ''} — הוא לא נפרט בקופה.`);
  }
  // 🔴 שתי טבלאות, שני מרחבי מזהים: הוצאה שהוזנה בטופס דוח ה-Z נשמרת ב-`cash_z_expense_id`
  // ולא ב-`cash_expense_id`, אחרת ה-FK מצביע על שורה אחרת לגמרי (או נכשל).
  const table = source === 'zclosing' ? 'z_closing_expenses' : 'z_expenses';
  const col = source === 'zclosing' ? 'cash_expense_id' : 'cash_z_expense_id';
  const expense = await x.one(`SELECT * FROM ${table} WHERE id = ?`, [Number(cashExpenseId)]);
  if (!expense) throw new NotFoundError('הוצאת המזומן לא נמצאה');
  const clash = await x.one(`SELECT id FROM salary_payments WHERE ${col} = ?`, [Number(cashExpenseId)]);
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
  await x.run(`UPDATE salary_payments SET cashed = 1, ${col} = ? WHERE id = ?`, [Number(cashExpenseId), id]);
  await logAction(
    { userId: actor?.id ?? null, action: 'salary.cashed', entityType: 'salary_payment', entityId: id, details: { cashExpenseId, source } },
    x,
  );
  // 🔴 התאמה של מזומן היא הרגע שבו כסף שיצא מהקופה מקבל הסבר — ולכן הבעלים רוצה לדעת עליה
  // בזמן אמת, גם כשמישהו אחר עשה אותה. notify דוחף לטלגרם **וגם** רושם התראה בפעמון.
  // getSalaryPayment מחזיר את שורת התשלום בלבד — שם העובד נשלף כאן, אחרת ההתראה אומרת "עובד"
  // ולא אומרת מי, וזו בדיוק האינפורמציה שבגללה שולחים אותה.
  const who = await x.one('SELECT first_name, last_name FROM employees WHERE id = ?', [row.employee_id]);
  const emp = `${who?.first_name || ''} ${who?.last_name || ''}`.trim();
  await notify(
    `💵 <b>הותאם תשלום שכר במזומן</b>\n${emp || 'עובד'} · ${fromAgorot(row.amount)} ₪`
      + `\nההוצאה מ${source === 'zclosing' ? 'סגירת Z' : 'דוח Z'} שויכה לתשלום השכר`
      + `${row.payment_id ? ' — הצ׳ק בוטל כדי שלא ייפרע פעם שנייה.' : '.'}`,
    { kind: 'cash_match', link: '/employees', storeId: row.store_id ?? null },
  );
  return getSalaryPayment(id, x);
}

/**
 * צ׳ק שכר שנפרע בבנק **לפני** שהותאם להוצאת מזומן.
 *
 * זה בדיוק המצב המסוכן: העובד לקח מזומן מהקופה וגם הצ׳ק נפרע בבנק — אותו שכר יצא פעמיים. כל
 * עוד ההתאמה נעשית בזמן, הצ׳ק מתבטל ולא מגיע לבנק; אם הבנק הקדים, אין מה לבטל ויש מה לברר.
 * ההתראה אומרת במפורש שהפירעון קדם להתאמה, ונשלחת פעם אחת (`cleared_alerted`).
 */
export async function alertOnSalaryChecksClearedBeforeMatch(x = getExecutor()) {
  let rows;
  try {
    rows = await x.many(
      `SELECT sp.id, sp.amount, sp.due_date, sp.reference, p.check_number, p.cleared_date,
              sp.store_id, e.first_name, e.last_name, st.name AS store_name
         FROM salary_payments sp
         JOIN payments p ON p.id = sp.payment_id
         JOIN employees e ON e.id = sp.employee_id
         JOIN stores st ON st.id = sp.store_id
        WHERE p.status = 'cleared' AND sp.cashed = 0
          AND sp.cash_expense_id IS NULL AND sp.cash_z_expense_id IS NULL
          AND sp.cleared_alerted IS NULL`,
      [],
    );
  } catch {
    return 0; // סכימה לפני העדכון
  }
  for (const r of rows) {
    await notify(
      `⚠️ <b>צ׳ק שכר נפרע בבנק — לפני שנעשתה התאמה</b>`
        + `\n${`${r.first_name || ''} ${r.last_name || ''}`.trim()} · ${fromAgorot(r.amount)} ₪`
        + `\nצ׳ק ${r.check_number || r.reference || ''} · ${r.store_name || ''} · נפרע ${r.cleared_date || ''}`
        + `\nהכסף עזב את הבנק בזמן שהשכר עדיין לא שויך להוצאת מזומן. אם העובד גם פרט אותו בקופה —`
        + ` אותו שכר יצא פעמיים.`,
      { kind: 'salary_cleared_unmatched', link: '/employees', storeId: r.store_id ?? null },
    );
    await x.run('UPDATE salary_payments SET cleared_alerted = ? WHERE id = ?',
      [new Date().toISOString().slice(0, 19).replace('T', ' '), r.id]);
  }
  return rows.length;
}

/** Undo the match (a mis-click). The voided check is NOT un-voided — that is a separate decision. */
export async function unmatchCashed(id, actor, x = getExecutor()) {
  await getSalaryPayment(id, x);
  await x.run('UPDATE salary_payments SET cashed = 0, cash_expense_id = NULL, cash_z_expense_id = NULL WHERE id = ?', [id]);
  await logAction({ userId: actor?.id ?? null, action: 'salary.uncashed', entityType: 'salary_payment', entityId: id }, x);
  return getSalaryPayment(id, x);
}


// ---------------------------------------------------------------- צ׳ק שכר ↔ תנועת בנק
// 🔴 צ׳ק שכר לא נרשם כ"תשלום" (טבלת payments), ולכן ההתאמה האוטומטית של הבנק — שעובדת רק מול
// payments — לא ראתה אותו: צ׳ק שכר שנפרע בבנק נשאר חיוב "ממתין להתאמה" בהתאמת בנק, ובדף העובדים
// לא הופיע שום סטטוס (נצפה אחרי הסנכרון הראשון: 13 צ׳קי שכר, אף אחד לא "הותאם").

let bankReadyCache = false;
/** האם `salary_payments.bank_txn_id` קיימת (לפני "עדכן מסד נתונים" — לא). */
export async function salaryBankReady(x = getExecutor()) {
  if (bankReadyCache) return true;
  try {
    await x.one('SELECT bank_txn_id FROM salary_payments LIMIT 1', []);
    bankReadyCache = true;
    return true;
  } catch {
    return false;
  }
}

/** מזהי תנועות בנק שכבר שויכו לצ׳ק שכר — כדי שלא ייחשבו "ממתינות להתאמה" בשום מקום. */
export async function salaryLinkedTxnIds(x = getExecutor()) {
  if (!(await salaryBankReady(x))) return new Set();
  const rows = await x.many('SELECT bank_txn_id FROM salary_payments WHERE bank_txn_id IS NOT NULL', []);
  return new Set(rows.map((r) => Number(r.bank_txn_id)));
}

const checkKey = (v) => plainNumber(String(v ?? '').trim()).replace(/\D/g, '').replace(/^0+/, '');
const DAY = 86_400_000;

/**
 * שיוך צ׳קי שכר של החנות לתנועות החיוב שלהם בחשבון הזה: **מספר צ׳ק זהה וסכום זהה בדיוק** — שני
 * התנאים, לא אחד מהם. מספר לבדו חוזר בין פנקסים; סכום לבדו חוזר בין עובדים. חלון תאריכים סביר
 * (60 יום לפני "לתאריך" עד 180 אחרי) מונע שיוך לפנקס של שנה אחרת. כל תנועה משויכת פעם אחת.
 *
 * צ׳ק שסומן "נפרט בקופה" **וגם** נפרע בבנק = אותו שכר יצא פעמיים (בדיוק מה שביטול הצ׳ק בקופה נועד
 * למנוע). הוא משויך כדי שיהיה גלוי, ונשלחת התראה.
 *
 * @returns {Promise<{matched:number, doublePaid:number}>}
 */
export async function matchSalaryChecksToBank(bankAccountId, actor, x = getExecutor()) {
  if (!(await salaryBankReady(x))) return { matched: 0, doublePaid: 0 };
  const acc = await x.one('SELECT id, store_id, company_id FROM bank_accounts WHERE id = ?', [Number(bankAccountId)]);
  if (!acc?.store_id) return { matched: 0, doublePaid: 0 };
  // 🔴 כל חנויות **החברה**, לא רק החנות של החשבון: שכר של חנות אחת יכול לצאת מהחשבון של חנות
  // אחרת באותה חברה, והגבלה לחנות הייתה משאירה צ׳ק כזה לא מותאם לנצח. מספר צ׳ק + סכום מדויק
  // מספיקים; בין חברות — לא (ספר כסף אחר).
  const companyStores = new Set((await x.many('SELECT id FROM stores WHERE company_id = ?', [acc.company_id]))
    .map((r) => Number(r.id)));
  const salaries = (await x.many(
    `SELECT sp.*, e.first_name, e.last_name FROM salary_payments sp JOIN employees e ON e.id = sp.employee_id
      WHERE sp.method = 'check' AND sp.bank_txn_id IS NULL AND sp.reference IS NOT NULL
      ORDER BY sp.due_date, sp.id`,
    [],
  )).filter((sp) => companyStores.has(Number(sp.store_id)) || Number(sp.store_id) === Number(acc.store_id));
  if (!salaries.length) return { matched: 0, doublePaid: 0 };
  const taken = await salaryLinkedTxnIds(x);
  const depRows = await x.many('SELECT matched_txn_id FROM deposits WHERE matched_txn_id IS NOT NULL', []);
  for (const d of depRows) taken.add(Number(d.matched_txn_id));
  const txns = (await x.many(
    `SELECT id, txn_date, amount, raw_reference, description FROM bank_transactions
      WHERE bank_account_id = ? AND amount < 0 AND matched_payment_id IS NULL ORDER BY txn_date, id`,
    [acc.id],
  )).filter((t) => !taken.has(Number(t.id)));

  let matched = 0;
  let doublePaid = 0;
  for (const sp of salaries) {
    const key = checkKey(sp.reference);
    if (!key) continue;
    const due = Date.parse(sp.due_date);
    const hit = txns.find((t) => !taken.has(Number(t.id))
      && checkKey(t.raw_reference) === key
      && -Number(t.amount) === Number(sp.amount)
      && (!Number.isFinite(due) || (Date.parse(t.txn_date) >= due - 60 * DAY && Date.parse(t.txn_date) <= due + 180 * DAY)));
    if (!hit) continue;
    taken.add(Number(hit.id));
    await x.run('UPDATE salary_payments SET bank_txn_id = ? WHERE id = ? AND bank_txn_id IS NULL', [hit.id, sp.id]);
    await logAction(
      { userId: actor?.id ?? null, action: 'salary.bank_cleared', entityType: 'salary_payment', entityId: sp.id,
        details: { txnId: hit.id, txnDate: hit.txn_date, reference: sp.reference } },
      x,
    );
    matched += 1;
    if (Number(sp.cashed)) {
      doublePaid += 1;
      const emp = `${sp.first_name || ''} ${sp.last_name || ''}`.trim();
      await notify(
        `🔴 <b>צ׳ק שכר נפרע גם בבנק וגם בקופה</b>\n${emp || 'עובד'} · ${fromAgorot(sp.amount)} ₪ · צ׳ק ${sp.reference}`
          + `\nהצ׳ק סומן כנפרט בקופה (הוצאת מזומן), ובכל זאת נפרע בבנק ב-${hit.txn_date}. אותו שכר יצא פעמיים.`,
        { kind: 'salary_double_paid', link: '/employees', storeId: sp.store_id ?? null },
      );
    }
  }
  return { matched, doublePaid };
}

/**
 * למה צ׳ק שכר עוד לא "נפרע בבנק" — אומר את זה בשורה עצמה במקום להשאיר את המשתמש לנחש (נצפה: 13
 * צ׳קים בלי סטטוס, ואין דרך לדעת אם הם לא נפרעו, או שנפרעו בסכום אחר, או שהאסמכתה שגויה).
 * מחפש בכל חשבונות החברה חיוב עם אותו מספר צ׳ק, ומחזיר משפט אחד לכל שורה (`r.bank_hint`).
 */
export async function attachSalaryBankHints(rows, x = getExecutor()) {
  const pending = (rows || []).filter((r) => r.method === 'check' && r.bank_txn_id == null && !Number(r.cashed));
  if (!pending.length || !(await salaryBankReady(x))) return rows;
  const stores = await x.many('SELECT id, company_id FROM stores', []);
  const companyOf = new Map(stores.map((st) => [Number(st.id), Number(st.company_id)]));
  // בלי שם החשבון בהודעה: הוא יכול להיות של חנות אחרת בחברה, מחוץ לסקופ של הצופה.
  const accounts = await x.many('SELECT id, company_id FROM bank_accounts', []);
  const accCompany = new Map(accounts.map((a) => [Number(a.id), Number(a.company_id)]));
  const linked = await salaryLinkedTxnIds(x);
  const byKey = new Map();
  for (const t of await x.many('SELECT id, bank_account_id, txn_date, amount, raw_reference, matched_payment_id FROM bank_transactions WHERE amount < 0', [])) {
    const k = checkKey(t.raw_reference);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  for (const r of pending) {
    const key = checkKey(r.reference);
    if (!key) { r.bank_hint = 'אין מספר צ׳ק באסמכתה — אין לפי מה להתאים'; continue; }
    const co = companyOf.get(Number(r.store_id));
    const hits = (byKey.get(key) || []).filter((t) => accCompany.get(Number(t.bank_account_id)) === co);
    if (!hits.length) { r.bank_hint = 'טרם נפרע בבנק (אין חיוב עם מספר הצ׳ק הזה)'; continue; }
    const same = hits.find((t) => -Number(t.amount) === Number(r.amount));
    if (same && linked.has(Number(same.id))) r.bank_hint = 'החיוב בבנק כבר שויך לצ׳ק שכר אחר';
    else if (same && same.matched_payment_id) r.bank_hint = `החיוב בבנק (${same.txn_date}) הותאם לתשלום ספק`;
    else if (same) r.bank_hint = `נמצא בבנק (${same.txn_date}) — לחץ "התאמה אוטומטית" בהתאמת בנק`;
    else {
      const t = hits[0];
      r.bank_hint = `בבנק צ׳ק ${r.reference} נפרע בסכום ${fromAgorot(-Number(t.amount))} ₪ (${t.txn_date}) — שונה מהסכום שהוזן`;
    }
  }
  return rows;
}
