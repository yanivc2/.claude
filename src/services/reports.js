import { getExecutor } from '../db/adapter.js';
import { scopeClause, scopeWhere, normalizeScope } from '../lib/scope.js';
import { revenueCoverage } from './revenueReports.js';
import { israelToday, addDaysIso } from '../lib/loginHours.js';
import { parseSearchTerms, anyTermLike } from '../lib/search.js';

/**
 * §7 "צ׳קים בחוץ" — outstanding checks. Per bank account, the sum of `issued` payments
 * is the live liability (money committed but not yet cleared). Manual clearing in stage 1.
 *
 * @returns {{ accounts: Array, totalOutstanding: number }}
 */
/**
 * Build a due-date (payment_date) cut condition on the `p` alias. Supports a single month
 * (YYYY-MM), a list of months (multi-select), or a from/to date range. Returns { cond, params }.
 */
function dueDateCut({ month = null, months = null, weeks = null, from = null, to = null } = {}) {
  // חתך שבועי (בעלים 21/10): כל שבוע = א׳ עד ש׳, לפי תאריך הפירעון.
  if (weeks && weeks.length) {
    const ors = weeks.map(() => '(p.payment_date >= ? AND p.payment_date <= ?)').join(' OR ');
    return { cond: ` AND (${ors})`, params: weeks.flatMap((w) => [w, addDaysIso(w, 6)]) };
  }
  if (from || to) {
    let cond = ''; const params = [];
    if (from) { cond += ' AND p.payment_date >= ?'; params.push(from); }
    if (to) { cond += ' AND p.payment_date <= ?'; params.push(to); }
    return { cond, params };
  }
  const list = (months && months.length) ? months : (month ? [month] : []);
  if (!list.length) return { cond: '', params: [] };
  const ors = list.map(() => 'p.payment_date LIKE ?').join(' OR ');
  return { cond: ` AND (${ors})`, params: list.map((m) => `${m}%`) };
}

export async function outstandingChecks(scope = null, cut = {}, x = getExecutor()) {
  const { storeId = null } = cut;
  // Optional due-date cut: single month, a list of months, or a from/to range.
  const dc = dueDateCut(cut);
  let accounts = await x.many(
    `SELECT ba.id, ba.display_name, ba.company_id AS company_id, st.id AS store_id,
            c.name AS company_name, st.name AS store_name,
            COALESCE(SUM(CASE WHEN p.status = 'issued'${dc.cond} THEN p.amount ELSE 0 END), 0) AS outstanding,
            COUNT(CASE WHEN p.status = 'issued'${dc.cond} THEN 1 END) AS outstanding_count
       FROM bank_accounts ba
       JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
       LEFT JOIN payments p ON p.bank_account_id = ba.id
      GROUP BY ba.id, ba.display_name, ba.company_id, st.id, c.name, st.name
      ORDER BY c.name, st.name`,
    [...dc.params, ...dc.params],
  );

  // The scope + the optional store cut (active-store context) are applied in JS on the per-account
  // rows, not in the WHERE: pg-mem refuses a lookup on a joined column inside this aggregation
  // ("lookups on joins"), and one row per bank account is a handful either way. The rows carry
  // company_id/store_id for exactly this.
  const { companyIds, storeIds } = normalizeScope(scope);
  if (companyIds != null) accounts = accounts.filter((a) => companyIds.includes(Number(a.company_id)));
  if (storeIds != null) accounts = accounts.filter((a) => storeIds.includes(Number(a.store_id)));
  if (storeId) accounts = accounts.filter((a) => Number(a.store_id) === Number(storeId));

  const totalOutstanding = accounts.reduce((sum, a) => sum + a.outstanding, 0);
  return { accounts, totalOutstanding };
}

/**
 * The contiguous list of months (YYYY-MM) that have any outstanding (issued) check, from the
 * earliest such month up to the latest — gaps filled, so a single unpaid check from Dec 2025
 * yields Dec 2025, Jan 2026, Feb 2026 … up to the last one (§9). For the month cut on the page.
 * @returns {Promise<Array<{value:string,label:string}>>}
 */
export async function outstandingMonths(scope = null, x = getExecutor()) {
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  const rows = await x.many(
    `SELECT p.payment_date FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
      WHERE p.status = 'issued'${sc.sql}`,
    [...sc.params],
  );
  const months = rows.map((r) => String(r.payment_date).slice(0, 7)).filter((m) => /^\d{4}-\d{2}$/.test(m));
  if (!months.length) return [];
  months.sort();
  const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  const [minY, minM] = months[0].split('-').map(Number);
  const [maxY, maxM] = months[months.length - 1].split('-').map(Number);
  const out = [];
  let y = minY;
  let m = minM;
  // Guard against a runaway loop on bad data — 600 months (50y) is far beyond any real horizon.
  for (let i = 0; i < 600 && (y < maxY || (y === maxY && m <= maxM)); i += 1) {
    out.push({ value: `${y}-${String(m).padStart(2, '0')}`, label: `${MONTHS_HE[m - 1]} ${y}` });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * השבועות (א׳–ש׳) שיש בהם צ׳ק פתוח לפי תאריך הפירעון — לחתך השבועי בצ׳קים בחוץ (בעלים 21/10). רק שבועות
 * שיש בהם צ׳קים (לא רצף מלא כמו בחודשים: שבועות ריקים היו מציפים את הרשימה).
 * @returns {Promise<Array<{value:string,label:string}>>} value = יום א׳ של השבוע (YYYY-MM-DD)
 */
export async function outstandingWeeks(scope = null, x = getExecutor()) {
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  const rows = await x.many(
    `SELECT p.payment_date FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
      WHERE p.status = 'issued'${sc.sql}`,
    [...sc.params],
  );
  const starts = new Set();
  for (const r of rows) {
    const d = String(r.payment_date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    starts.add(addDaysIso(d, -new Date(`${d}T00:00:00Z`).getUTCDay()));
  }
  const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  return [...starts].sort().map((w) => ({ value: w, label: `${dm(w)}–${dm(addDaysIso(w, 6))}/${addDaysIso(w, 6).slice(2, 4)}` }));
}

/**
 * Latest known balance per account (from the most recent bank transaction that carried one).
 * Accounts without any stored balance are omitted — the caller shows nothing for them.
 */
export async function latestBalances(scope = null, x = getExecutor()) {
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  const accounts = await x.many(
    `SELECT ba.id AS account_id, ba.display_name, c.name AS company_name, st.name AS store_name
       FROM bank_accounts ba
       JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
      WHERE 1 = 1${sc.sql}
      ORDER BY c.name, st.name`,
    [...sc.params],
  );
  // Fetch balance-bearing txns newest-first and pick the first per account in JS (portable).
  // Tolerate a pre-upgrade DB that lacks the balance_after column — just show no balances.
  let txns = [];
  try {
    txns = await x.many(
      `SELECT bank_account_id, balance_after, txn_date, id
         FROM bank_transactions
        WHERE balance_after IS NOT NULL
        ORDER BY txn_date DESC, id DESC`,
      [],
    );
  } catch {
    return [];
  }
  const latest = new Map();
  for (const t of txns) if (!latest.has(t.bank_account_id)) latest.set(t.bank_account_id, t);
  return accounts
    .map((a) => {
      const t = latest.get(a.account_id);
      return t ? { ...a, balance: t.balance_after, asOf: t.txn_date } : null;
    })
    .filter(Boolean);
}

/** Issued (outstanding) checks whose payment_date falls in [fromIso, toIso], for the calendar. */
export async function outstandingChecksInRange(fromIso, toIso, scope = null, x = getExecutor()) {
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  return x.many(
    `SELECT p.id, p.payment_date, p.amount, p.method, p.check_number, p.reference, p.batch_number,
            c.name AS company_name, st.name AS store_name
       FROM payments p
       JOIN bank_accounts ba ON ba.id = p.bank_account_id
       JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
      WHERE p.status = 'issued' AND p.payment_date BETWEEN ? AND ?${sc.sql}
      ORDER BY p.payment_date, p.id`,
    [fromIso, toIso, ...sc.params],
  );
}

/** The individual outstanding (issued) checks for a given bank account. */
export async function outstandingChecksForAccount(bankAccountId, x = getExecutor()) {
  return x.many(
    `SELECT p.* FROM payments p
      WHERE p.bank_account_id = ? AND p.status = 'issued'
      ORDER BY p.payment_date`,
    [bankAccountId],
  );
}

/**
 * Detailed outstanding-check rows for a bank account — one row per open check, joining its
 * invoice line(s) and any credit note(s). Columns for the report:
 *   supplier, invoice number(s)+date+amount, credit number(s)+amount, due date, net amount.
 */
export async function outstandingCheckDetail(bankAccountId, cut = {}, x = getExecutor()) {
  const dc = dueDateCut(cut);
  const payments = await x.many(
    `SELECT p.id, p.payment_date, p.amount, p.method, p.check_number, p.reference, p.batch_number, p.supplier_id
       FROM payments p
      WHERE p.bank_account_id = ? AND p.status = 'issued'${dc.cond}
      ORDER BY p.payment_date, p.id`,
    [bankAccountId, ...dc.params],
  );
  if (payments.length === 0) return [];

  const ph = payments.map(() => '?').join(',');
  const lines = await x.many(
    `SELECT pl.payment_id, pl.amount_applied,
            i.id AS invoice_id, i.invoice_number, i.invoice_date, i.doc_type, i.total_amount,
            s.name AS supplier_name
       FROM payment_lines pl
       JOIN invoices i ON i.id = pl.invoice_id
       JOIN suppliers s ON s.id = i.supplier_id
      WHERE pl.payment_id IN (${ph})
      ORDER BY pl.id`,
    payments.map((p) => p.id),
  );

  const byPayment = new Map();
  for (const l of lines) {
    if (!byPayment.has(l.payment_id)) byPayment.set(l.payment_id, []);
    byPayment.get(l.payment_id).push(l);
  }
  // תשלום על החשבון (מקדמה) אין לו שורות חשבונית — הספק שלו יושב על התשלום עצמו. בלעדיו השורה
  // הציגה עמודת ספק ריקה, ואי אפשר היה לדעת למי יצא הצ׳ק.
  const advSupIds = [...new Set(payments.filter((p) => p.supplier_id && !byPayment.has(p.id)).map((p) => Number(p.supplier_id)))];
  const supName = new Map();
  if (advSupIds.length) {
    const rows = await x.many(`SELECT id, name FROM suppliers WHERE id IN (${advSupIds.map(() => '?').join(',')})`, advSupIds);
    for (const r of rows) supName.set(Number(r.id), r.name);
  }

  return payments.map((p) => {
    const ls = byPayment.get(p.id) || [];
    const pos = ls.filter((l) => l.doc_type !== 'credit_note' && l.total_amount >= 0);
    const neg = ls.filter((l) => l.doc_type === 'credit_note' || l.total_amount < 0);
    return {
      paymentId: p.id,
      method: p.method,
      ident: p.check_number || p.reference || p.batch_number || '',
      supplierName: (pos[0] || ls[0] || {}).supplier_name || supName.get(Number(p.supplier_id)) || '',
      isAdvance: !ls.length && !!p.supplier_id,
      invoiceNumbers: pos.map((l) => l.invoice_number).join(', '),
      invoiceDate: (pos[0] || {}).invoice_date || '',
      invoiceAmount: pos.reduce((s, l) => s + l.total_amount, 0),
      creditNumbers: neg.map((l) => l.invoice_number).join(', '),
      creditAmount: neg.reduce((s, l) => s + Math.abs(l.total_amount), 0),
      dueDate: p.payment_date,
      amount: p.amount,
      invoiceIds: pos.map((l) => l.invoice_id),
    };
  });
}

/**
 * "התאמה לפי סכום" לצ׳קים בחוץ — לכל צ׳ק פתוח: חיובים בבנק **באותו סכום בדיוק**, באותו חשבון, שעוד
 * לא הותאמו לשום דבר, בחלון סביב תאריך הפירעון (14 יום לפני עד 180 יום אחרי — צ׳ק נפרע אחרי
 * הפירעון, לפעמים חודשים אחריו; לפני הפירעון רק בטעות של הבנק).
 *
 * ההתאמה האוטומטית (`autoReconcile`) דורשת מספר צ׳ק; צ׳ק שנרשם בלי מספר, או שהבנק כתב לו אסמכתה
 * אחרת, נשאר "בחוץ" לנצח גם אחרי שנפרע. כאן מציעים — לא מתאימים לבד: סכום זהה לבדו אינו הוכחה.
 * `unique` = הצ׳ק היחיד שמתאים לתנועה הזו **והתנועה היחידה** שמתאימה לצ׳ק — רק אלה נכנסים ל"התאם
 * את כל החד-משמעיים".
 *
 * @param {number} bankAccountId
 * @param {Array<{paymentId:number, amount:number, dueDate:string}>} detail שורות outstandingCheckDetail
 * @returns {Promise<Map<number, {candidates: Array, unique: boolean}>>}
 */
export const OUTSTANDING_MATCH_BEFORE_DAYS = 14;
export const OUTSTANDING_MATCH_AFTER_DAYS = 180;
export async function outstandingBankCandidates(bankAccountId, detail, x = getExecutor()) {
  const out = new Map();
  if (!detail || !detail.length) return out;
  const txns = await x.many(
    `SELECT id, txn_date, amount, description, raw_reference FROM bank_transactions
      WHERE bank_account_id = ? AND amount < 0 AND matched_payment_id IS NULL ORDER BY txn_date, id`,
    [bankAccountId],
  );
  // חיוב שכבר שויך לתשלום שכר אינו פנוי (שיוך השכר יושב על salary_payments, לא על התנועה).
  const { salaryLinkedTxnIds } = await import('./salaryPayments.js');
  const salaryTaken = await salaryLinkedTxnIds(x);
  const free = txns.filter((t) => !salaryTaken.has(Number(t.id)));
  const shift = (iso, days) => {
    const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const usage = new Map(); // txnId → מספר הצ׳קים שהיא מועמדת להם
  for (const r of detail) {
    const due = String(r.dueDate || '').slice(0, 10);
    const lo = due ? shift(due, -OUTSTANDING_MATCH_BEFORE_DAYS) : '';
    const hi = due ? shift(due, OUTSTANDING_MATCH_AFTER_DAYS) : '9999-12-31';
    const candidates = free.filter((t) => Math.abs(Number(t.amount)) === Number(r.amount)
      && String(t.txn_date) >= lo && String(t.txn_date) <= hi);
    for (const t of candidates) usage.set(Number(t.id), (usage.get(Number(t.id)) || 0) + 1);
    out.set(Number(r.paymentId), { candidates, unique: false });
  }
  // 🔴 חוק ברזל (בעלים 21/10): חיוב שמספר הצ׳ק שלו **סותר** את הצ׳ק הפתוח נשאר הצעה בלחיצה אחת-אחת, אבל
  // לעולם לא נכנס ל"התאם את כל החד-משמעיים" — כך נוצרה שרשרת 31606→31919→32151→32537 במידנייט.
  const { checkNumberConflict } = await import('./reconciliation.js');
  for (const r of detail) {
    const v = out.get(Number(r.paymentId));
    const pay = { method: r.method, check_number: r.method === 'check' ? r.ident : null };
    for (const t of v.candidates) t.numberDiffers = checkNumberConflict(t, pay);
    v.unique = v.candidates.length === 1 && usage.get(Number(v.candidates[0].id)) === 1 && !v.candidates[0].numberDiffers;
  }
  return out;
}

/**
 * §7 "בדיקת חשבונית" — invoice lookup by invoice number, allocation number, or supplier name.
 */
export async function invoiceLookup(query, { companyId = null, storeId = null, scope = null, unpaidOnly = false, by = 'all', dateFrom = null, dateTo = null } = {}, x = getExecutor()) {
  const terms = parseSearchTerms(query);
  // טווח תאריכים (לוח הבקרה, בעלים 18/10) — לפי **תאריך החשבונית**. טווח לבדו (בלי שם/מספר) הוא חיפוש
  // תקף: כל החשבוניות בטווח, בתחום החנות.
  if (!terms.length && !dateFrom && !dateTo) return [];
  // `by`: 'number' (מספר חשבונית / הקצאה), 'name' (שם ספק) או 'all'. לוח הבקרה מחפש בשני שדות נפרדים
  // (בעלים, 16/10: "הפרד חיפוש שמי מחיפוש של ברקוד") — מספר לא נתפס כחלק משם ספק, ולהפך.
  const cols = by === 'number' ? ['i.invoice_number', 'i.allocation_number']
    : by === 'name' ? ['s.name'] : ['i.invoice_number', 'i.allocation_number', 's.name'];
  // בלי מונח (טווח בלבד) — תנאי ניטרלי. לא `1 = 1`: pg-mem זורק עליו "lookups on joins" כשאחריו בא תנאי
  // על i (נמדד); `i.id > 0` זהה בתוצאה ועובר בשני הניבים.
  const m = terms.length ? anyTermLike(terms, cols) : { sql: 'i.id > 0', params: [] };
  const params = [...m.params];
  let filter = '';
  if (unpaidOnly) filter += " AND i.status <> 'paid'";
  if (dateFrom) { filter += ' AND i.invoice_date >= ?'; params.push(dateFrom); }
  if (dateTo) { filter += ' AND i.invoice_date <= ?'; params.push(dateTo); }
  if (companyId) {
    filter += ' AND i.company_id = ?';
    params.push(companyId);
  }
  if (storeId) {
    filter += ' AND i.store_id = ?';
    params.push(storeId);
  }
  const sc = scopeWhere(scope, 'i.company_id', 'i.store_id');
  filter += sc.sql;
  params.push(...sc.params);

  return x.many(
    `SELECT i.id, i.invoice_number, i.allocation_number, i.invoice_date,
            i.total_amount, i.doc_type, i.status AS invoice_status,
            s.name AS supplier_name, st.name AS store_name,
            p.check_number, p.status AS payment_status, p.cleared_date
       FROM invoices i
       JOIN suppliers s ON s.id = i.supplier_id
       JOIN stores st ON st.id = i.store_id
       LEFT JOIN payment_lines pl ON pl.invoice_id = i.id
       LEFT JOIN payments p ON p.id = pl.payment_id
      WHERE ${m.sql}${filter}
      ORDER BY i.id DESC`,
    params,
  );
}

/** Every 'YYYY-MM-DD' from `from` to `to`, inclusive ([] when to < from). */
function daysBetween(from, to) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || Number.isNaN(end.getTime())) return out;
  while (d <= end && out.length < 1000) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * §7 "רווחיות" — per-store gross profit for a date range: purchases (invoices) vs sales.
 *
 * 🔴 Sales come ONLY from the nightly "דוח פדיון" (owner, 18/10: "אתה לא יכול לחשב ריווחיות
 * מדוחות הזד") — a Z is closed at irregular intervals (Thursday, then Sunday), so a Z total does
 * not belong to the days of the range and a week or month cut through it is wrong. The revenue
 * report is produced every day, and a missed one is easy to re-issue at the till — so instead of
 * falling back, every day of the range with no report is LISTED (missingDays) for the owner to
 * fetch. Days that cannot have a report yet (today and later) are not expected.
 * A store with no report in the range has no sales figure → grossProfit/margins = null, not
 * "−purchases".
 */
export async function profitability(fromDate, toDate, scope = null, x = getExecutor(), { today = israelToday() } = {}) {
  // Aggregate purchases and sales per store separately, then merge in JS — avoids correlated
  // subqueries (portable across SQLite/Postgres and cheaper than a per-store subquery).
  const sc = scopeWhere(scope, 'c.id', 'st.id');
  const storeRows = await x.many(
    `SELECT st.id, st.name AS store_name, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id
      WHERE 1 = 1${sc.sql}
      ORDER BY c.name, st.name`,
    [...sc.params],
  );
  const purchaseRows = await x.many(
    `SELECT store_id, COALESCE(SUM(total_amount),0) AS amt FROM invoices
      WHERE invoice_date BETWEEN ? AND ? GROUP BY store_id`,
    [fromDate, toDate],
  );
  const purchaseByStore = new Map(purchaseRows.map((r) => [Number(r.store_id), Number(r.amt) || 0]));
  // Day reports + period reports (a period counts only when the range holds all of it, and a day row
  // inside such a period is not added twice) — services/revenueReports.js#revenueCoverage.
  const coverage = await revenueCoverage(fromDate, toDate, x);
  const lastExpected = toDate < today ? toDate : minusOneDay(today); // tonight's report is not late yet
  const expectedDays = daysBetween(fromDate, lastExpected);

  const stores = storeRows.map((r) => {
    const purchases = purchaseByStore.get(Number(r.id)) || 0;
    const rev = coverage.get(Number(r.id)) || null;
    const revenueSales = rev ? rev.sales : 0;
    const revenueCredit = rev ? rev.credit : 0;
    const have = rev ? rev.days : new Set();
    const revenueDays = have.size;
    const missingDays = expectedDays.filter((d) => !have.has(d));
    // A period report that reaches outside the range cannot be split — named under the store's sales
    // so a "missing" day there is understood ("קיים דוח 01/10–16/10, החורג מהטווח").
    const outsidePeriods = rev ? rev.outside : [];
    const hasSales = revenueDays > 0;
    const sales = revenueSales;
    const grossProfit = hasSales ? sales - purchases : null;
    const marginPct = hasSales && sales > 0 ? (grossProfit / sales) * 100 : null;
    const markupPct = hasSales && purchases > 0 ? (grossProfit / purchases) * 100 : null;
    return {
      ...r, purchases, sales, revenueSales, revenueCredit, revenueDays, expectedDays: expectedDays.length,
      missingDays, outsidePeriods, complete: hasSales && missingDays.length === 0, grossProfit, marginPct, markupPct,
    };
  });

  // Profit totals cover only the stores that have sales — adding a store's purchases with no
  // sales against them would show a loss that is really a missing report.
  const withSales = stores.filter((s) => s.grossProfit !== null);
  const sum = (list, k) => list.reduce((n, s) => n + s[k], 0);
  const totals = {
    purchases: sum(stores, 'purchases'),
    sales: sum(stores, 'sales'),
    revenueSales: sum(stores, 'revenueSales'),
    revenueCredit: sum(stores, 'revenueCredit'),
    grossProfit: withSales.length ? sum(withSales, 'grossProfit') : null,
    profitPurchases: sum(withSales, 'purchases'),
    storesWithoutSales: stores.length - withSales.length,
    complete: stores.length > 0 && stores.every((s) => s.complete),
  };
  totals.marginPct = totals.grossProfit !== null && totals.sales > 0 ? (totals.grossProfit / totals.sales) * 100 : null;
  totals.markupPct = totals.grossProfit !== null && totals.profitPurchases > 0 ? (totals.grossProfit / totals.profitPurchases) * 100 : null;

  return { stores, totals, expectedDays: expectedDays.length };
}

function minusOneDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Small counters for the dashboard. `storeId` (the active-store context) narrows the store-bound
 * counters; pending-suppliers is company-level (suppliers aren't store-scoped) so it's unaffected. */
export async function dashboardStats(scope = null, storeId = null, x = getExecutor()) {
  const sc = scopeWhere(scope, 'company_id', 'store_id');
  const st = storeId ? ' AND store_id = ?' : '';
  const stp = storeId ? [storeId] : [];
  const pendingSuppliers = (await x.one("SELECT COUNT(*) AS n FROM suppliers WHERE status = 'pending'", [])).n;
  const onHoldInvoices = (await x.one(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'on_hold'${sc.sql}${st}`, [...sc.params, ...stp])).n;
  const approvedInvoices = (await x.one(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'approved_for_payment'${sc.sql}${st}`, [...sc.params, ...stp])).n;
  const { totalOutstanding } = await outstandingChecks(scope, { storeId }, x);
  const lastReconciled = await lastReconciliationFor(scope, storeId, x);
  const lastBankPull = await lastBankPullFor(scope, storeId, x);
  return { pendingSuppliers, onHoldInvoices, approvedInvoices, totalOutstanding, lastReconciled, lastBankPull };
}

/**
 * The timestamp of the most recent bank-reconciliation action (auto-match or a
 * confirmed manual match). Used on the dashboard as "התאמת בנק אחרונה".
 * @returns {string|null} audit_log timestamp ('YYYY-MM-DD HH:MM:SS') or null if never reconciled.
 */
export async function lastReconciliationAt(x = getExecutor()) {
  const row = await x.one(
    `SELECT MAX(timestamp) AS ts FROM audit_log WHERE action IN ('reconcile.match', 'reconcile.auto')`,
    [],
  );
  return row && row.ts ? row.ts : null;
}

/**
 * Last bank reconciliation **per store**, for the dashboard cube. Derived directly from the matched
 * bank transactions (`bank_transactions.matched_payment_id IS NOT NULL`) — the single source of
 * truth for what's reconciled, set by both manual and auto matching. Each transaction belongs to a
 * bank account, and a bank account belongs to exactly one store, so the store attribution is exact
 * (no audit-log indirection that could cross-link a date to the wrong store). The "date" is the most
 * recent reconciled transaction's date per store. In JS we apply the company scope and pick: the
 * active store's own last date when one is set, else the most recent across the authorized stores
 * (with its store name — the dashboard shows the name only under "all stores").
 * @returns {Promise<{ts:string, storeName:string} | null>}
 */
export async function lastReconciliationFor(scope = null, storeId = null, x = getExecutor()) {
  const rows = await x.many(
    `SELECT ba.store_id AS store_id, ba.company_id AS company_id, st.name AS store_name, MAX(bt.txn_date) AS ts
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
       JOIN stores st ON st.id = ba.store_id
      WHERE bt.matched_payment_id IS NOT NULL
      GROUP BY ba.store_id, ba.company_id, st.name`,
    [],
  );
  return latestInScope(rows, scope, storeId);
}

/** Per-store rows `{store_id, company_id, store_name, ts}` → the active store's own row, or (no active
 * store) the most recent across the stores the scope allows — with its store name. */
function latestInScope(rows, scope, storeId) {
  const { companyIds, storeIds } = normalizeScope(scope);
  const allowCompany = companyIds == null ? null : new Set(companyIds.map(Number));
  const allowStore = storeIds == null ? null : new Set(storeIds.map(Number));
  const byStore = new Map();
  for (const r of rows) {
    if (!r.ts) continue;
    if (allowCompany && !allowCompany.has(Number(r.company_id))) continue;
    if (allowStore && !allowStore.has(Number(r.store_id))) continue;
    byStore.set(Number(r.store_id), { ts: r.ts, storeName: r.store_name });
  }
  if (storeId) return byStore.get(Number(storeId)) || null; // that store's own date, or nothing
  let best = null;
  for (const r of byStore.values()) if (!best || String(r.ts) > String(best.ts)) best = r;
  return best;
}

/**
 * מתי נמשכו לאחרונה נתונים מהבנק — לאריח "נמשכו נתונים מהבנק" בלוח הבקרה (בעלים, 18/10; היה "התאמת בנק
 * אחרונה" = תאריך התנועה המותאמת האחרונה, שאינו אומר מתי הגיע מידע מהבנק). כל משיכה — קובץ, סנכרון,
 * סוכן המשרד או סקרייפר — עוברת ב-`importTransactions` ונרשמת ב-`bank_imports.imported_at` (UTC; להצגה
 * `israelStamp`). מסד שלפני "עדכן מסד נתונים" (אין `bank_imports`) → null, ודף התאמת הבנק מתריע על כך.
 * @returns {Promise<{ts:string, storeName:string} | null>}
 */
export async function lastBankPullFor(scope = null, storeId = null, x = getExecutor()) {
  let rows;
  try {
    rows = await x.many(
      `SELECT ba.store_id AS store_id, ba.company_id AS company_id, st.name AS store_name, MAX(bi.imported_at) AS ts
         FROM bank_imports bi
         JOIN bank_accounts ba ON ba.id = bi.bank_account_id
         JOIN stores st ON st.id = ba.store_id
        GROUP BY ba.store_id, ba.company_id, st.name`,
      [],
    );
  } catch {
    return null;
  }
  return latestInScope(rows, scope, storeId);
}
