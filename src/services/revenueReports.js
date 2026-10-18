import { getExecutor, nowTs } from '../db/adapter.js';
import { scopeWhere } from '../lib/scope.js';
import { logAction } from './audit.js';

// "דוח פדיון" — the nightly per-store revenue report (total sales + credit clearing). This is the
// SYSTEMATIC sales source for profitability: Z reports are entered at irregular hours and not every
// day, while this report arrives automatically each night. One row per store per business day.

/**
 * 🔴 probe: do the summary-detail columns exist (cash_total … cards)? On a DB that was not upgraded
 * the import still saves פדיון + אשראי and SAYS the rest was dropped — instead of throwing (no
 * report at all) or silently storing half a report (CLAUDE.md · catch that guards a DB).
 */
export async function revenueDetailsReady(x = getExecutor()) {
  try {
    await x.many('SELECT cash_total, txn_count, cards FROM revenue_reports LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

const DETAIL_COLS = ['cash_total', 'on_account', 'debt_payments', 'debt_credit', 'cancel_amount', 'cancel_count', 'txn_count', 'cards'];
const intOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

/** A parsed row's details in DETAIL_COLS order; all NULL for a row from a per-day table. */
function detailValues(r) {
  if (!('cash' in r)) return DETAIL_COLS.map(() => null);
  return [
    intOrNull(r.cash), intOrNull(r.onAccount), intOrNull(r.debtPayments), intOrNull(r.debtCredit),
    intOrNull(r.cancelAmount), intOrNull(r.cancelCount), intOrNull(r.txnCount),
    Array.isArray(r.cards) ? JSON.stringify(r.cards) : null,
  ];
}

/**
 * Upsert daily revenue rows for one store. Re-importing a day replaces it — details included (the
 * report is the source of truth), so re-sending the same nightly mail is harmless.
 * @param {number} storeId
 * @param {Array<{date:string, gross:number, credit:number, cash?:number, cards?:Array}>} rows
 * @param {'upload'|'email'} source
 * @returns {Promise<{inserted:number, updated:number, detailsSaved:boolean}>} detailsSaved=false
 *          when the rows carried details the DB has no columns for yet ("עדכן מסד נתונים").
 */
export async function importRevenueRows(storeId, rows, source, actor = null, x = getExecutor()) {
  let inserted = 0;
  let updated = 0;
  const hasDetails = (rows || []).some((r) => r && 'cash' in r);
  const ready = await revenueDetailsReady(x);
  for (const r of rows || []) {
    if (!r || !r.date) continue;
    const gross = Number(r.gross) || 0;
    const credit = Number(r.credit) || 0;
    const extra = ready ? DETAIL_COLS : [];
    const extraVals = ready ? detailValues(r) : [];
    const existing = await x.one('SELECT id FROM revenue_reports WHERE store_id = ? AND report_date = ?', [storeId, r.date]);
    if (existing) {
      await x.run(
        `UPDATE revenue_reports SET gross_sales = ?, credit_total = ?, source = ?${extra.map((c) => `, ${c} = ?`).join('')} WHERE id = ?`,
        [gross, credit, source, ...extraVals, existing.id],
      );
      updated += 1;
    } else {
      await x.run(
        `INSERT INTO revenue_reports (store_id, report_date, gross_sales, credit_total, source, created_at${extra.map((c) => `, ${c}`).join('')})
         VALUES (?, ?, ?, ?, ?, ?${extra.map(() => ', ?').join('')})`,
        [storeId, r.date, gross, credit, source, nowTs(), ...extraVals],
      );
      inserted += 1;
    }
  }
  await logAction(
    { userId: actor?.id ?? null, action: 'revenue.import', entityType: 'store', entityId: storeId, details: { source, inserted, updated } },
    x,
  );
  return { inserted, updated, detailsSaved: ready || !hasDetails };
}

/**
 * The checks the owner reads a day by (17/10): "אשראי מגירה צריך להיות = אשראי לפי חברה (אם שילמו
 * חוב בהקפה אז לשים לב)". The acquirers' total counts debts paid by card too, so the drawer side is
 * card sales + card debt payments. null where the row has no details.
 * @returns {{cards:Array, cardsTotal:number|null, creditGap:number|null, debt:number}}
 */
export function revenueChecks(row) {
  let cards = [];
  try { cards = row && row.cards ? JSON.parse(row.cards) : []; } catch { cards = []; }
  if (!Array.isArray(cards)) cards = [];
  const cardsTotal = cards.length ? cards.reduce((s, c) => s + (Number(c.total) || 0), 0) : null;
  const drawer = (Number(row && row.credit_total) || 0) + (Number(row && row.debt_credit) || 0);
  return {
    cards,
    cardsTotal,
    creditGap: cardsTotal === null ? null : cardsTotal - drawer,
    debt: Number(row && row.debt_payments) || 0,
  };
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

/** Recent daily rows for the "ימים אחרונים שנקלטו" tables (newest first), each with its checks. */
export async function listRevenue({ storeId = null, limit = 30, scope = null } = {}, x = getExecutor()) {
  const sc = scopeWhere(scope, 'st.company_id', 'st.id');
  const st = storeId ? ' AND r.store_id = ?' : '';
  const rows = await x.many(
    `SELECT r.*, st.name AS store_name
       FROM revenue_reports r JOIN stores st ON st.id = r.store_id
      WHERE 1 = 1${sc.sql}${st}
      ORDER BY r.report_date DESC, r.id DESC
      LIMIT ?`,
    [...sc.params, ...(storeId ? [storeId] : []), limit],
  );
  return rows.map((r) => ({ ...r, checks: revenueChecks(r) }));
}
