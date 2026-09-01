import { getExecutor } from '../db/adapter.js';
import { scopeClause, scopeWhere, normalizeScope } from '../lib/scope.js';
import { revenueInRange } from './revenueReports.js';
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
function dueDateCut({ month = null, months = null, from = null, to = null } = {}) {
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
  const sc = scopeWhere(scope, 'ba.company_id', 'ba.store_id');
  // Optional due-date cut: single month, a list of months, or a from/to range.
  const dc = dueDateCut(cut);
  let accounts = await x.many(
    `SELECT ba.id, ba.display_name, st.id AS store_id, c.name AS company_name, st.name AS store_name,
            COALESCE(SUM(CASE WHEN p.status = 'issued'${dc.cond} THEN p.amount ELSE 0 END), 0) AS outstanding,
            COUNT(CASE WHEN p.status = 'issued'${dc.cond} THEN 1 END) AS outstanding_count
       FROM bank_accounts ba
       JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
       LEFT JOIN payments p ON p.bank_account_id = ba.id
      WHERE 1 = 1${sc.sql}
      GROUP BY ba.id, ba.display_name, st.id, c.name, st.name
      ORDER BY c.name, st.name`,
    [...dc.params, ...dc.params, ...sc.params],
  );

  // Optional store cut (active-store context). Post-filtered in JS on the per-store rows — pg-mem
  // can't put a joined column in this GROUP BY query's WHERE, and real Postgres/SQLite match here.
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
    `SELECT p.id, p.payment_date, p.amount, p.method, p.check_number, p.reference, p.batch_number
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

  return payments.map((p) => {
    const ls = byPayment.get(p.id) || [];
    const pos = ls.filter((l) => l.doc_type !== 'credit_note' && l.total_amount >= 0);
    const neg = ls.filter((l) => l.doc_type === 'credit_note' || l.total_amount < 0);
    return {
      paymentId: p.id,
      method: p.method,
      ident: p.check_number || p.reference || p.batch_number || '',
      supplierName: (pos[0] || ls[0] || {}).supplier_name || '',
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
 * §7 "בדיקת חשבונית" — invoice lookup by invoice number, allocation number, or supplier name.
 */
export async function invoiceLookup(query, { companyId = null, storeId = null, scope = null, unpaidOnly = false } = {}, x = getExecutor()) {
  const terms = parseSearchTerms(query);
  if (!terms.length) return [];
  const m = anyTermLike(terms, ['i.invoice_number', 'i.allocation_number', 's.name']);
  const params = [...m.params];
  let filter = '';
  if (unpaidOnly) filter += " AND i.status <> 'paid'";
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

/**
 * §7 "רווחיות" — per-store gross profit for a date range: purchases (net invoices) vs sales
 * (register Z totals). Gross profit = sales − purchases; margin = gross profit / sales.
 */
export async function profitability(fromDate, toDate, scope = null, x = getExecutor()) {
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
  const salesRows = await x.many(
    `SELECT store_id, COALESCE(SUM(daily_total),0) AS amt FROM z_reports
      WHERE z_date BETWEEN ? AND ? GROUP BY store_id`,
    [fromDate, toDate],
  );
  const purchaseByStore = new Map(purchaseRows.map((r) => [r.store_id, r.amt]));
  const salesByStore = new Map(salesRows.map((r) => [r.store_id, r.amt]));
  // "דוח פדיון" — the nightly revenue report. It is the systematic sales source (Z reports are
  // entered irregularly), so when a store has report days in range its revenue drives the profit;
  // stores with no report fall back to the Z totals, unchanged.
  const revenueByStore = await revenueInRange(fromDate, toDate, x);

  const stores = storeRows.map((r) => {
    const purchases = purchaseByStore.get(r.id) || 0;
    const zSales = salesByStore.get(r.id) || 0;
    const rev = revenueByStore.get(Number(r.id)) || null;
    const revenueSales = rev ? rev.sales : 0;
    const revenueCredit = rev ? rev.credit : 0;
    const revenueDays = rev ? rev.days : 0;
    const usesRevenue = revenueDays > 0;
    const sales = usesRevenue ? revenueSales : zSales; // profit basis
    const grossProfit = sales - purchases;
    const marginPct = sales > 0 ? (grossProfit / sales) * 100 : null;
    const markupPct = purchases > 0 ? (grossProfit / purchases) * 100 : null;
    return { ...r, purchases, sales, zSales, revenueSales, revenueCredit, revenueDays, usesRevenue, grossProfit, marginPct, markupPct };
  });

  const totals = stores.reduce(
    (acc, s) => {
      acc.purchases += s.purchases;
      acc.sales += s.sales;
      acc.zSales += s.zSales;
      acc.revenueSales += s.revenueSales;
      acc.revenueCredit += s.revenueCredit;
      acc.grossProfit += s.grossProfit;
      return acc;
    },
    { purchases: 0, sales: 0, zSales: 0, revenueSales: 0, revenueCredit: 0, grossProfit: 0 },
  );
  totals.marginPct = totals.sales > 0 ? (totals.grossProfit / totals.sales) * 100 : null;
  totals.markupPct = totals.purchases > 0 ? (totals.grossProfit / totals.purchases) * 100 : null;

  return { stores, totals };
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
  return { pendingSuppliers, onHoldInvoices, approvedInvoices, totalOutstanding, lastReconciled };
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
