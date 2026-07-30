import { getDb } from '../db/index.js';

/**
 * §7 "צ׳קים בחוץ" — outstanding checks. Per bank account, the sum of `issued` payments
 * is the live liability (money committed but not yet cleared). Manual clearing in stage 1.
 *
 * @returns {{ accounts: Array, totalOutstanding: number }}
 */
export function outstandingChecks(db = getDb()) {
  const accounts = db
    .prepare(
      `SELECT ba.id, ba.display_name, c.name AS company_name, st.name AS store_name,
              COALESCE(SUM(CASE WHEN p.status = 'issued' THEN p.amount ELSE 0 END), 0) AS outstanding,
              COUNT(CASE WHEN p.status = 'issued' THEN 1 END) AS outstanding_count
         FROM bank_accounts ba
         JOIN companies c ON c.id = ba.company_id
         JOIN stores st ON st.id = ba.store_id
         LEFT JOIN payments p ON p.bank_account_id = ba.id
        GROUP BY ba.id
        ORDER BY c.name, st.name`,
    )
    .all();

  const totalOutstanding = accounts.reduce((sum, a) => sum + a.outstanding, 0);
  return { accounts, totalOutstanding };
}

/** The individual outstanding (issued) checks for a given bank account. */
export function outstandingChecksForAccount(bankAccountId, db = getDb()) {
  return db
    .prepare(
      `SELECT p.* FROM payments p
        WHERE p.bank_account_id = ? AND p.status = 'issued'
        ORDER BY p.payment_date`,
    )
    .all(bankAccountId);
}

/**
 * §7 "בדיקת חשבונית" (feature 2) — invoice lookup by invoice number, allocation number,
 * or supplier name. Returns each matching invoice with supplier, amounts, the paying
 * check number (if any) and its clearing status.
 *
 * @param {string} query  free text
 */
export function invoiceLookup(query, db = getDb()) {
  const q = (query ?? '').trim();
  if (!q) return [];
  const like = `%${q}%`;

  return db
    .prepare(
      `SELECT i.id, i.invoice_number, i.allocation_number, i.invoice_date,
              i.total_amount, i.doc_type, i.status AS invoice_status,
              s.name AS supplier_name, st.name AS store_name,
              p.check_number, p.status AS payment_status, p.cleared_date
         FROM invoices i
         JOIN suppliers s ON s.id = i.supplier_id
         JOIN stores st ON st.id = i.store_id
         LEFT JOIN payment_lines pl ON pl.invoice_id = i.id
         LEFT JOIN payments p ON p.id = pl.payment_id
        WHERE i.invoice_number LIKE ?
           OR i.allocation_number LIKE ?
           OR s.name LIKE ?
        ORDER BY i.id DESC`,
    )
    .all(like, like, like);
}

/** Small counters for the dashboard. */
export function dashboardStats(db = getDb()) {
  const pendingSuppliers = db
    .prepare("SELECT COUNT(*) AS n FROM suppliers WHERE status = 'pending'")
    .get().n;
  const onHoldInvoices = db
    .prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'on_hold'")
    .get().n;
  const approvedInvoices = db
    .prepare("SELECT COUNT(*) AS n FROM invoices WHERE status = 'approved_for_payment'")
    .get().n;
  const { totalOutstanding } = outstandingChecks(db);
  return { pendingSuppliers, onHoldInvoices, approvedInvoices, totalOutstanding };
}
