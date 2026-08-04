import { getExecutor } from '../db/adapter.js';
import { scopeClause } from '../lib/scope.js';

/**
 * §7 "צ׳קים בחוץ" — outstanding checks. Per bank account, the sum of `issued` payments
 * is the live liability (money committed but not yet cleared). Manual clearing in stage 1.
 *
 * @returns {{ accounts: Array, totalOutstanding: number }}
 */
export async function outstandingChecks(scope = null, x = getExecutor()) {
  const sc = scopeClause(scope, 'ba.company_id');
  const accounts = await x.many(
    `SELECT ba.id, ba.display_name, st.id AS store_id, c.name AS company_name, st.name AS store_name,
            COALESCE(SUM(CASE WHEN p.status = 'issued' THEN p.amount ELSE 0 END), 0) AS outstanding,
            COUNT(CASE WHEN p.status = 'issued' THEN 1 END) AS outstanding_count
       FROM bank_accounts ba
       JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
       LEFT JOIN payments p ON p.bank_account_id = ba.id
      WHERE 1 = 1${sc.sql}
      GROUP BY ba.id, ba.display_name, st.id, c.name, st.name
      ORDER BY c.name, st.name`,
    [...sc.params],
  );

  const totalOutstanding = accounts.reduce((sum, a) => sum + a.outstanding, 0);
  return { accounts, totalOutstanding };
}

/**
 * Latest known balance per account (from the most recent bank transaction that carried one).
 * Accounts without any stored balance are omitted — the caller shows nothing for them.
 */
export async function latestBalances(scope = null, x = getExecutor()) {
  const sc = scopeClause(scope, 'ba.company_id');
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
  const sc = scopeClause(scope, 'ba.company_id');
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
export async function outstandingCheckDetail(bankAccountId, x = getExecutor()) {
  const payments = await x.many(
    `SELECT p.id, p.payment_date, p.amount, p.method, p.check_number, p.reference, p.batch_number
       FROM payments p
      WHERE p.bank_account_id = ? AND p.status = 'issued'
      ORDER BY p.payment_date, p.id`,
    [bankAccountId],
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
export async function invoiceLookup(query, { companyId = null, storeId = null, scope = null } = {}, x = getExecutor()) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;
  const params = [like, like, like];
  let filter = '';
  if (companyId) {
    filter += ' AND i.company_id = ?';
    params.push(companyId);
  }
  if (storeId) {
    filter += ' AND i.store_id = ?';
    params.push(storeId);
  }
  const sc = scopeClause(scope, 'i.company_id');
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
      WHERE (i.invoice_number LIKE ? OR i.allocation_number LIKE ? OR s.name LIKE ?)${filter}
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
  const sc = scopeClause(scope, 'c.id');
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

  const stores = storeRows.map((r) => {
    const purchases = purchaseByStore.get(r.id) || 0;
    const sales = salesByStore.get(r.id) || 0;
    const grossProfit = sales - purchases;
    const marginPct = sales > 0 ? (grossProfit / sales) * 100 : null;
    const markupPct = purchases > 0 ? (grossProfit / purchases) * 100 : null;
    return { ...r, purchases, sales, grossProfit, marginPct, markupPct };
  });

  const totals = stores.reduce(
    (acc, s) => {
      acc.purchases += s.purchases;
      acc.sales += s.sales;
      acc.grossProfit += s.grossProfit;
      return acc;
    },
    { purchases: 0, sales: 0, grossProfit: 0 },
  );
  totals.marginPct = totals.sales > 0 ? (totals.grossProfit / totals.sales) * 100 : null;
  totals.markupPct = totals.purchases > 0 ? (totals.grossProfit / totals.purchases) * 100 : null;

  return { stores, totals };
}

/** Small counters for the dashboard. */
export async function dashboardStats(scope = null, x = getExecutor()) {
  const sc = scopeClause(scope, 'company_id');
  const pendingSuppliers = (await x.one("SELECT COUNT(*) AS n FROM suppliers WHERE status = 'pending'", [])).n;
  const onHoldInvoices = (await x.one(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'on_hold'${sc.sql}`, [...sc.params])).n;
  const approvedInvoices = (await x.one(`SELECT COUNT(*) AS n FROM invoices WHERE status = 'approved_for_payment'${sc.sql}`, [...sc.params])).n;
  const { totalOutstanding } = await outstandingChecks(scope, x);
  const lastReconciledAt = await lastReconciliationAt(x);
  return { pendingSuppliers, onHoldInvoices, approvedInvoices, totalOutstanding, lastReconciledAt };
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
