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
      `SELECT id, txn_date, amount FROM bank_transactions WHERE id IN (${linked.map(() => '?').join(',')})`,
      linked,
    );
    const byId = new Map(txns.map((t) => [Number(t.id), t]));
    for (const r of rows) {
      if (r.bank_txn_id == null) continue;
      const t = byId.get(Number(r.bank_txn_id));
      r.bank_date = t?.txn_date || null;
      // הפרש שאושר (bank_note): כמה יצא מהבנק מעבר לסכום שהוזן — מוצג לצד ההסבר.
      r.bank_diff_amount = t ? -Number(t.amount) - Number(r.amount) : 0;
    }
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
  // שורת בנק שכבר נמשכה (למשל צ׳ק שתוקן והוזן מחדש) — מותאמת מיד, בלי "התאמה אוטומטית".
  // בכל חשבונות החברה, כמו בסנכרון. כשל כאן לא מפיל רישום שכבר נשמר.
  if (method !== 'cash') {
    try {
      const store = await x.one('SELECT company_id FROM stores WHERE id = ?', [storeId]);
      const accounts = store ? await x.many('SELECT id FROM bank_accounts WHERE company_id = ?', [store.company_id]) : [];
      for (const a of accounts) await matchSalaryChecksToBank(a.id, actor, x);
    } catch { /* ההתאמה תרוץ בסנכרון הבא */ }
  }
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
 * שיוך תשלומי שכר של החברה לתנועות החיוב שלהם בחשבון הזה: **אסמכתה זהה וסכום זהה בדיוק** — שני
 * התנאים, לא אחד מהם. צ׳ק — לפי מספר הצ׳ק; **העברה / מקבץ** — לפי האסמכתה (נצפה: העברות שכר עם
 * אסמכתה נשארו בלי התאמה כי רק צ׳קים נבדקו). מקבץ יכול לצאת מהבנק כ**חיוב אחד** לכמה עובדים: אם
 * אין חיוב בסכום של שורה בודדת, קבוצת שורות באותה אסמכתה שסכומן שווה לחיוב משויכת אליו יחד.
 * חלון תאריכים (60 יום לפני "לתאריך" עד 180 אחרי) מונע שיוך לפנקס/אסמכתה של תקופה אחרת.
 *
 * צ׳ק שסומן "נפרט בקופה" **וגם** נפרע בבנק = אותו שכר יצא פעמיים. הוא משויך כדי שיהיה גלוי,
 * ונשלחת התראה.
 *
 * @returns {Promise<{matched:number, doublePaid:number}>}
 */
export async function matchSalaryChecksToBank(bankAccountId, actor, x = getExecutor()) {
  if (!(await salaryBankReady(x))) return { matched: 0, doublePaid: 0 };
  const acc = await x.one('SELECT id, store_id, company_id FROM bank_accounts WHERE id = ?', [Number(bankAccountId)]);
  if (!acc?.store_id) return { matched: 0, doublePaid: 0 };
  // 🔴 כל חנויות **החברה**, לא רק החנות של החשבון: שכר של חנות אחת יכול לצאת מהחשבון של חנות
  // אחרת באותה חברה. בין חברות — לא (ספר כסף אחר).
  const companyStores = new Set((await x.many('SELECT id FROM stores WHERE company_id = ?', [acc.company_id]))
    .map((r) => Number(r.id)));
  const salaries = (await x.many(
    `SELECT sp.*, e.first_name, e.last_name FROM salary_payments sp JOIN employees e ON e.id = sp.employee_id
      WHERE sp.method IN ('check', 'transfer', 'batch') AND sp.bank_txn_id IS NULL AND sp.reference IS NOT NULL
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
  const inWindow = (t, dueDate) => {
    const due = Date.parse(dueDate);
    const d = Date.parse(t.txn_date);
    return !Number.isFinite(due) || (d >= due - 60 * DAY && d <= due + 180 * DAY);
  };

  let matched = 0;
  let doublePaid = 0;
  const link = async (sp, hit) => {
    await x.run('UPDATE salary_payments SET bank_txn_id = ? WHERE id = ? AND bank_txn_id IS NULL', [hit.id, sp.id]);
    await logAction(
      { userId: actor?.id ?? null, action: 'salary.bank_cleared', entityType: 'salary_payment', entityId: sp.id,
        details: { txnId: hit.id, txnDate: hit.txn_date, reference: sp.reference, method: sp.method } },
      x,
    );
    matched += 1;
    if (sp.method === 'check' && Number(sp.cashed)) {
      doublePaid += 1;
      const emp = `${sp.first_name || ''} ${sp.last_name || ''}`.trim();
      await notify(
        `🔴 <b>צ׳ק שכר נפרע גם בבנק וגם בקופה</b>\n${emp || 'עובד'} · ${fromAgorot(sp.amount)} ₪ · צ׳ק ${sp.reference}`
          + `\nהצ׳ק סומן כנפרט בקופה (הוצאת מזומן), ובכל זאת נפרע בבנק ב-${hit.txn_date}. אותו שכר יצא פעמיים.`,
        { kind: 'salary_double_paid', link: '/employees', storeId: sp.store_id ?? null },
      );
    }
  };

  // 1) שורה אחת ↔ חיוב אחד (צ׳ק, העברה בודדת)
  const done = new Set();
  for (const sp of salaries) {
    const key = checkKey(sp.reference);
    if (!key) continue;
    const hit = txns.find((t) => !taken.has(Number(t.id)) && checkKey(t.raw_reference) === key
      && -Number(t.amount) === Number(sp.amount) && inWindow(t, sp.due_date));
    if (!hit) continue;
    taken.add(Number(hit.id));
    done.add(sp.id);
    await link(sp, hit);
  }
  // 2) מקבץ: כמה העברות באותה אסמכתה ↔ חיוב אחד בסכום הכולל
  const groups = new Map();
  for (const sp of salaries) {
    if (done.has(sp.id) || sp.method === 'check') continue;
    const key = checkKey(sp.reference);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sp);
  }
  for (const [key, rows] of groups) {
    if (rows.length < 2) continue;
    const total = rows.reduce((n, r) => n + Number(r.amount), 0);
    const hit = txns.find((t) => !taken.has(Number(t.id)) && checkKey(t.raw_reference) === key
      && -Number(t.amount) === total && inWindow(t, rows[0].due_date));
    if (!hit) continue;
    taken.add(Number(hit.id));
    for (const sp of rows) await link(sp, hit);
  }
  return { matched, doublePaid };
}

/**
 * למה צ׳ק שכר עוד לא "נפרע בבנק" — אומר את זה בשורה עצמה במקום להשאיר את המשתמש לנחש (נצפה: 13
 * צ׳קים בלי סטטוס, ואין דרך לדעת אם הם לא נפרעו, או שנפרעו בסכום אחר, או שהאסמכתה שגויה).
 * מחפש בכל חשבונות החברה חיוב עם אותו מספר צ׳ק, ומחזיר משפט אחד לכל שורה (`r.bank_hint`).
 */
export async function attachSalaryBankHints(rows, x = getExecutor()) {
  const pending = (rows || []).filter((r) => ['check', 'transfer', 'batch'].includes(r.method)
    && r.bank_txn_id == null && !Number(r.cashed));
  if (!pending.length || !(await salaryBankReady(x))) return rows;
  const stores = await x.many('SELECT id, company_id FROM stores', []);
  const companyOf = new Map(stores.map((st) => [Number(st.id), Number(st.company_id)]));
  // בלי שם החשבון בהודעה: הוא יכול להיות של חנות אחרת בחברה, מחוץ לסקופ של הצופה.
  const accounts = await x.many('SELECT id, company_id FROM bank_accounts', []);
  const accCompany = new Map(accounts.map((a) => [Number(a.id), Number(a.company_id)]));
  const linked = await salaryLinkedTxnIds(x);
  const noteReady = await salaryBankNoteReady(x);
  const byKey = new Map();
  for (const t of await x.many('SELECT id, bank_account_id, txn_date, amount, raw_reference, matched_payment_id FROM bank_transactions WHERE amount < 0', [])) {
    const k = checkKey(t.raw_reference);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const allDebits = [...byKey.values()].flat();
  const noRef = await x.many("SELECT id, bank_account_id, txn_date, amount, raw_reference FROM bank_transactions WHERE amount < 0 AND (raw_reference IS NULL OR raw_reference = '')", []);
  for (const r of pending) {
    const what = r.method === 'check' ? 'מספר הצ׳ק' : 'האסמכתה';
    const key = checkKey(r.reference);
    if (!key) { r.bank_hint = `אין ${what} — אין לפי מה להתאים`; continue; }
    const co = companyOf.get(Number(r.store_id));
    const hits = (byKey.get(key) || []).filter((t) => accCompany.get(Number(t.bank_account_id)) === co);
    if (!hits.length) {
      // אסמכתה שלא נמצאה — אולי הוקלדה אסמכתה אחרת (למשל של אתר הבנק ולא של דף החשבון): מציעים
      // חיוב פנוי באותו סכום בדיוק, כדי שיהיה ברור מה לתקן.
      const due = Date.parse(r.due_date);
      const near = [...allDebits, ...noRef].find((t) => accCompany.get(Number(t.bank_account_id)) === co
        && -Number(t.amount) === Number(r.amount) && !t.matched_payment_id && !linked.has(Number(t.id))
        && (!Number.isFinite(due) || Math.abs(Date.parse(t.txn_date) - due) <= 45 * DAY));
      r.bank_hint = near
        ? `אין בבנק חיוב עם ${what} ${r.method === 'check' ? 'הזה' : 'הזו'} — אבל יש חיוב באותו סכום ב-${near.txn_date}${near.raw_reference ? ` (אסמכתה ${near.raw_reference})` : ''}. אם זה הוא — עדכן את ${what}.`
        : (r.method === 'check' ? 'טרם נפרע בבנק (אין חיוב עם מספר הצ׳ק הזה)' : 'אין בבנק חיוב עם האסמכתה הזו');
      continue;
    }
    const same = hits.find((t) => -Number(t.amount) === Number(r.amount));
    if (same && linked.has(Number(same.id))) r.bank_hint = 'החיוב בבנק כבר שויך לתשלום שכר אחר';
    else if (same && same.matched_payment_id) r.bank_hint = `החיוב בבנק (${same.txn_date}) הותאם לתשלום ספק`;
    else if (same) r.bank_hint = `נמצא בבנק (${same.txn_date}) — לחץ "התאמה אוטומטית" בהתאמת בנק`;
    else {
      const t = hits[0];
      // "אשר התאמה עם הפרש" — רק לשורה בודדת (לא מקבץ: שם ההפרש הוא של הקבוצה, לא של שורה אחת),
      // ורק כשהחיוב פנוי. אותה אסמכתה בדיוק; הסכום שהוזן נשאר.
      const free = hits.find((h) => !h.matched_payment_id && !linked.has(Number(h.id)));
      if (r.method !== 'batch' && free && noteReady) {
        r.bank_diff = { txnId: Number(free.id), amount: -Number(free.amount), diff: -Number(free.amount) - Number(r.amount), date: free.txn_date };
      }
      r.bank_hint = r.method === 'check'
        ? `בבנק צ׳ק ${r.reference} נפרע בסכום ${fromAgorot(-Number(t.amount))} ₪ (${t.txn_date}) — שונה מהסכום שהוזן`
        : `בבנק אסמכתה ${r.reference} בסכום ${fromAgorot(-Number(t.amount))} ₪ (${t.txn_date}) — שונה מהסכום שהוזן${r.method === 'batch' ? ' (אם זה מקבץ של כמה עובדים — ודא שכל השורות שלו הוזנו עם אותה אסמכתה)' : ''}`;
    }
  }
  return rows;
}

let noteReadyCache = false;
/** האם `salary_payments.bank_note` קיימת (לפני "עדכן מסד נתונים" — לא, והכפתור לא מוצג). */
export async function salaryBankNoteReady(x = getExecutor()) {
  if (noteReadyCache) return true;
  try {
    await x.one('SELECT bank_note FROM salary_payments LIMIT 1', []);
    noteReadyCache = true;
    return true;
  } catch {
    return false;
  }
}

export const BANK_NOTE_MAX = 500;

/**
 * "אשר התאמה עם הפרש" — הצ׳ק נכתב בסכום שונה במעט ממה שהוזן (נצפה: 2,383.66 בבנק מול 2,383.60
 * בשכר), וההפרש אושר. **הסכום שהוזן נשאר** — הוא השכר האמיתי; מה ששגוי הוא הצ׳ק. השורה משויכת
 * לחיוב, וההסבר נשמר איתה ומוצג לצד ההפרש. בלי הסבר — אין אישור.
 *
 * 🔴 רק מה שבוודאות אותו תשלום: אותה אסמכתה/מספר צ׳ק בדיוק, חיוב פנוי (לא משויך לתשלום ספק,
 * לשכר אחר או להפקדה), באותה חברה, שורה שעוד לא הותאמה ולא נפרטה בקופה. לא מקבץ.
 */
export async function approveSalaryBankDiff(id, txnId, note, actor, x = getExecutor()) {
  if (!(await salaryBankNoteReady(x))) throw new RuleError('R', 'נדרש עדכון מסד נתונים (הגדרות ← "עדכן מסד נתונים").');
  const text = String(note ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) throw new RuleError('VALIDATION', 'כדי לאשר התאמה עם הפרש צריך לכתוב הערה — למה ההפרש בסדר');
  if (text.length > BANK_NOTE_MAX) throw new RuleError('VALIDATION', `ההערה ארוכה מדי (עד ${BANK_NOTE_MAX} תווים)`);
  const row = await getSalaryPayment(Number(id), x);
  if (row.bank_txn_id) throw new RuleError('R', 'תשלום השכר כבר הותאם לבנק');
  if (Number(row.cashed)) throw new RuleError('R', 'תשלום השכר סומן כנפרט בקופה');
  if (!['check', 'transfer'].includes(row.method)) throw new RuleError('R', 'אישור הפרש זמין לצ׳ק ולהעברה בודדת בלבד');
  const txn = await x.one('SELECT id, bank_account_id, amount, raw_reference, matched_payment_id, txn_date FROM bank_transactions WHERE id = ?', [Number(txnId)]);
  if (!txn || !(Number(txn.amount) < 0)) throw new NotFoundError('תנועת הבנק לא נמצאה');
  if (txn.matched_payment_id) throw new RuleError('R', 'החיוב בבנק כבר הותאם לתשלום אחר');
  if ((await salaryLinkedTxnIds(x)).has(Number(txn.id))) throw new RuleError('R', 'החיוב בבנק כבר שויך לתשלום שכר אחר');
  if (await x.one('SELECT id FROM deposits WHERE matched_txn_id = ?', [txn.id])) throw new RuleError('R', 'החיוב בבנק שויך להפקדה');
  if (!checkKey(row.reference) || checkKey(txn.raw_reference) !== checkKey(row.reference)) {
    throw new RuleError('R', 'האסמכתה בבנק שונה מהאסמכתה של תשלום השכר — מאשרים הפרש רק לאותה אסמכתה');
  }
  const acc = await x.one('SELECT company_id FROM bank_accounts WHERE id = ?', [txn.bank_account_id]);
  const st = await x.one('SELECT company_id FROM stores WHERE id = ?', [row.store_id]);
  if (!acc || !st || Number(acc.company_id) !== Number(st.company_id)) throw new RuleError('R', 'החיוב שייך לחשבון של חברה אחרת');

  const bankAmount = -Number(txn.amount);
  await x.run('UPDATE salary_payments SET bank_txn_id = ?, bank_note = ? WHERE id = ? AND bank_txn_id IS NULL', [txn.id, text, row.id]);
  await logAction(
    { userId: actor?.id ?? null, action: 'salary.bank_diff_approved', entityType: 'salary_payment', entityId: row.id,
      details: { amount: row.amount, bankAmount, diff: bankAmount - Number(row.amount), txnId: txn.id, txnDate: txn.txn_date, note: text } },
    x,
  );
  return getSalaryPayment(row.id, x);
}
