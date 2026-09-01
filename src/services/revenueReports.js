import { getExecutor, nowTs } from '../db/adapter.js';
import { scopeWhere } from '../lib/scope.js';
import { logAction } from './audit.js';

// "דוח פדיון" — the nightly per-store revenue report (total sales + credit clearing). This is the
// SYSTEMATIC sales source for profitability: Z reports are entered at irregular hours and not every
// day, while this report arrives automatically each night. One row per store per business day.

/**
 * Upsert daily revenue rows for one store. Re-importing a day replaces it (the report is the
 * source of truth), so re-sending the same nightly mail is harmless.
 * @param {number} storeId
 * @param {Array<{date:string, gross:number, credit:number}>} rows
 * @param {'upload'|'email'} source
 * @returns {Promise<{inserted:number, updated:number}>}
 */
export async function importRevenueRows(storeId, rows, source, actor = null, x = getExecutor()) {
  let inserted = 0;
  let updated = 0;
  for (const r of rows || []) {
    if (!r || !r.date) continue;
    const gross = Number(r.gross) || 0;
    const credit = Number(r.credit) || 0;
    const existing = await x.one('SELECT id FROM revenue_reports WHERE store_id = ? AND report_date = ?', [storeId, r.date]);
    if (existing) {
      await x.run('UPDATE revenue_reports SET gross_sales = ?, credit_total = ?, source = ? WHERE id = ?', [gross, credit, source, existing.id]);
      updated += 1;
    } else {
      await x.run(
        'INSERT INTO revenue_reports (store_id, report_date, gross_sales, credit_total, source, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [storeId, r.date, gross, credit, source, nowTs()],
      );
      inserted += 1;
    }
  }
  await logAction(
    { userId: actor?.id ?? null, action: 'revenue.import', entityType: 'store', entityId: storeId, details: { source, inserted, updated } },
    x,
  );
  return { inserted, updated };
}

/**
 * Revenue totals per store for a date range → Map<store_id, {sales, credit, days}>.
 * Feeds the "דוח פדיון" column on the profitability page.
 */
export async function revenueInRange(fromDate, toDate, x = getExecutor()) {
  const rows = await x.many(
    `SELECT store_id,
            COALESCE(SUM(gross_sales),0)  AS sales,
            COALESCE(SUM(credit_total),0) AS credit,
            COUNT(*) AS days
       FROM revenue_reports
      WHERE report_date BETWEEN ? AND ?
      GROUP BY store_id`,
    [fromDate, toDate],
  );
  return new Map(rows.map((r) => [Number(r.store_id), { sales: Number(r.sales) || 0, credit: Number(r.credit) || 0, days: Number(r.days) || 0 }]));
}

/** Recent daily rows for the "דוח פדיון מידנייט" rubric (newest first). */
export async function listRevenue({ storeId = null, limit = 30, scope = null } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 'st.id');
  const st = storeId ? ' AND r.store_id = ?' : '';
  return x.many(
    `SELECT r.*, st.name AS store_name
       FROM revenue_reports r JOIN stores st ON st.id = r.store_id
      WHERE 1 = 1${sc.sql}${st}
      ORDER BY r.report_date DESC, r.id DESC
      LIMIT ?`,
    [...sc.params, ...(storeId ? [storeId] : []), limit],
  );
}
