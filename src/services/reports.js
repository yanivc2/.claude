import { getExecutor } from '../db/adapter.js';

/**
 * §7 "צ׳קים בחוץ" — outstanding checks. Per bank account, the sum of `issued` payments
 * is the live liability (money committed but not yet cleared). Manual clearing in stage 1.
 *
 * @returns {{ accounts: Array, totalOutstanding: number }}
 */
export async function outstandingChecks(x = getExecutor()) {
  const accounts = await x.many(
    `SELECT ba.id, ba.display_name, c.name AS company_name, st.name AS store_name,
            COALESCE(SUM(CASE WHEN p.status = 'issued' THEN p.amount ELSE 0 END), 0) AS outstanding,
            COUNT(CASE WHEN p.status = 'issued' THEN 1 END) AS outstanding_count
       FROM bank_accounts ba
       JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
       LEFT JOIN payments p ON p.bank_account_id = ba.id
      GROUP BY ba.id, ba.display_name, c.name, st.name
      ORDER BY c.name, st.name`,
    [],
  );

  const totalOutstanding = accounts.reduce((sum, a) => sum + a.outstanding, 0);
  return { accounts, totalOutstanding };
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
 * §7 "בדיקת חשבונית" — invoice lookup by invoice number, allocation number, or supplier name.
 */
export async function invoiceLookup(query, { companyId = null, storeId = null } = {}, x = getExecutor()) {
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
export async function profitability(fromDate, toDate, x = getExecutor()) {
  // Aggregate purchases and sales per store separately, then merge in JS — avoids correlated
  // subqueries (portable across SQLite/Postgres and cheaper than a per-store subquery).
  const storeRows = await x.many(
    `SELECT st.id, st.name AS store_name, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id
      ORDER BY c.name, st.name`,
    [],
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
export async function dashboardStats(x = getExecutor()) {
  const pendingSuppliers = (await x.one("SELECT COUNT(*) AS n FROM suppliers WHERE status = 'pending'", [])).n;
  const onHoldInvoices = (await x.one("SELECT COUNT(*) AS n FROM invoices WHERE status = 'on_hold'", [])).n;
  const approvedInvoices = (await x.one("SELECT COUNT(*) AS n FROM invoices WHERE status = 'approved_for_payment'", [])).n;
  const { totalOutstanding } = await outstandingChecks(x);
  return { pendingSuppliers, onHoldInvoices, approvedInvoices, totalOutstanding };
}
