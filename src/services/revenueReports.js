import { getExecutor, nowTs } from '../db/adapter.js';
import { scopeWhere } from '../lib/scope.js';
import { logAction } from './audit.js';
import { RuleError } from '../lib/errors.js';
import { parseRevenueReportAny } from '../lib/revenueReportFile.js';
import { resolveStoreByTitle } from '../lib/revenueIngest.js';
import { formatIls } from '../lib/money.js';

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
    await x.many('SELECT cash_total, txn_count, cards, receipt_count, void_count FROM revenue_reports LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

const DETAIL_COLS = [
  'cash_total', 'on_account', 'debt_payments', 'debt_credit', 'cancel_amount', 'cancel_count', 'txn_count', 'cards',
  'cash_count', 'credit_count', 'receipt_count', 'discount_amount', 'discount_count', 'void_amount', 'void_count',
];
const intOrNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));

/** A parsed row's details in DETAIL_COLS order; all NULL for a row from a per-day table. */
function detailValues(r) {
  if (!('cash' in r)) return DETAIL_COLS.map(() => null);
  return [
    intOrNull(r.cash), intOrNull(r.onAccount), intOrNull(r.debtPayments), intOrNull(r.debtCredit),
    intOrNull(r.cancelAmount), intOrNull(r.cancelCount), intOrNull(r.txnCount),
    Array.isArray(r.cards) ? JSON.stringify(r.cards) : null,
    intOrNull(r.cashCount), intOrNull(r.creditCount), intOrNull(r.receiptCount),
    intOrNull(r.discountAmount), intOrNull(r.discountCount), intOrNull(r.voidAmount), intOrNull(r.voidCount),
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
  // ±2 agorot = the report's own rounding (three acquirers, each rounded) — not a gap. Measured: the
  // 01/10–15/10 report of ג'וניור is 1 agora off.
  const gap = cardsTotal === null ? null : cardsTotal - drawer;
  return {
    cards,
    cardsTotal,
    creditGap: gap !== null && Math.abs(gap) <= 2 ? 0 : gap,
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

// ---- דוח פדיון תקופתי ----------------------------------------------------------------------------
// One report for a range of days (owner, 18/10: the days before the nightly intake, issued at the till
// as 01/10–16/10). It cannot be split into days, so it is ONE row; profitability counts it only for a
// range that holds all of it, and its days then count as covered.

/** 🔴 probe: does `revenue_periods` exist? (CLAUDE.md · a catch that guards a DB.) */
export async function revenuePeriodsReady(x = getExecutor()) {
  try {
    await x.many('SELECT id FROM revenue_periods LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

const DETAIL_KEYS = ['cash', 'onAccount', 'debtPayments', 'debtCredit', 'cards', 'txnCount', 'cancelAmount', 'cancelCount',
  'cashCount', 'creditCount', 'receiptCount', 'discountAmount', 'discountCount', 'voidAmount', 'voidCount'];

/**
 * Store one period report. The report is the source of truth for its days: an earlier period of the
 * same store that overlaps it is replaced (01/10–15/10, then 01/10–17/10 → only the second counts).
 * @param {{from:string, to:string, gross:number, credit:number}} period  `to` = last day, inclusive
 * @returns {Promise<{inserted:boolean, replaced:Array<{from:string,to:string}>}>}
 */
export async function importRevenuePeriod(storeId, period, source, actor = null, x = getExecutor()) {
  if (!(await revenuePeriodsReady(x))) {
    throw new RuleError('VALIDATION', 'דוח תקופתי דורש עדכון מסד נתונים — הגדרות ← "עדכון מסד נתונים", ואז להעלות שוב.');
  }
  const { from, to } = period;
  const details = JSON.stringify(Object.fromEntries(DETAIL_KEYS.filter((k) => k in period).map((k) => [k, period[k]])));
  const overlapping = await x.many(
    'SELECT id, date_from, date_to FROM revenue_periods WHERE store_id = ? AND date_from <= ? AND date_to >= ?',
    [storeId, to, from],
  );
  const replaced = overlapping.filter((p) => !(p.date_from === from && p.date_to === to)).map((p) => ({ from: p.date_from, to: p.date_to }));
  for (const p of overlapping) await x.run('DELETE FROM revenue_periods WHERE id = ?', [p.id]);
  await x.run(
    `INSERT INTO revenue_periods (store_id, date_from, date_to, gross_sales, credit_total, details, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [storeId, from, to, Number(period.gross) || 0, Number(period.credit) || 0, details, source, nowTs()],
  );
  await logAction(
    { userId: actor?.id ?? null, action: 'revenue.import_period', entityType: 'store', entityId: storeId, details: { source, from, to, replaced: replaced.length } },
    x,
  );
  return { inserted: true, replaced };
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function daysOf(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 1000; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * What the revenue reports say about a range, per store → Map<store_id, {sales, credit, days:Set,
 * periods:[{from,to}], outside:[{from,to}]}>.
 *  • a period inside the range counts whole, and its days are covered; a day row inside such a period
 *    is NOT added again (the period already holds it);
 *  • a period that sticks out of the range cannot be split → not counted (`outside`, for the note);
 *  • every other day row counts.
 */
export async function revenueCoverage(fromDate, toDate, x = getExecutor()) {
  const out = new Map();
  const of = (id) => {
    const k = Number(id);
    if (!out.has(k)) out.set(k, { sales: 0, credit: 0, days: new Set(), periods: [], outside: [] });
    return out.get(k);
  };
  if (await revenuePeriodsReady(x)) {
    const periods = await x.many(
      'SELECT store_id, date_from, date_to, gross_sales, credit_total FROM revenue_periods WHERE date_from <= ? AND date_to >= ? ORDER BY date_from',
      [toDate, fromDate],
    );
    for (const p of periods) {
      const c = of(p.store_id);
      if (p.date_from >= fromDate && p.date_to <= toDate) {
        c.sales += Number(p.gross_sales) || 0;
        c.credit += Number(p.credit_total) || 0;
        daysOf(p.date_from, p.date_to).forEach((d) => c.days.add(d));
        c.periods.push({ from: p.date_from, to: p.date_to });
      } else {
        c.outside.push({ from: p.date_from, to: p.date_to });
      }
    }
  }
  const rows = await x.many(
    'SELECT store_id, report_date, gross_sales, credit_total FROM revenue_reports WHERE report_date BETWEEN ? AND ?',
    [fromDate, toDate],
  );
  for (const r of rows) {
    const c = of(r.store_id);
    const day = String(r.report_date).slice(0, 10);
    if (c.days.has(day)) continue; // inside a counted period — already in its total
    c.sales += Number(r.gross_sales) || 0;
    c.credit += Number(r.credit_total) || 0;
    c.days.add(day);
  }
  return out;
}

/** Period rows for the "ימים אחרונים שנקלטו" table, shaped like day rows (+ period_to). */
export async function listRevenuePeriods({ limit = 20, scope = null } = {}, x = getExecutor()) {
  if (!(await revenuePeriodsReady(x))) return [];
  const sc = scopeWhere(scope, 'st.company_id', 'st.id');
  const rows = await x.many(
    `SELECT p.*, st.name AS store_name
       FROM revenue_periods p JOIN stores st ON st.id = p.store_id
      WHERE p.id > 0${sc.sql}
      ORDER BY p.date_to DESC, p.id DESC
      LIMIT ?`,
    [...sc.params, limit],
  );
  return rows.map((p) => {
    let d = {};
    try { d = p.details ? JSON.parse(p.details) : {}; } catch { d = {}; }
    const row = {
      id: p.id, store_id: p.store_id, store_name: p.store_name, source: p.source,
      report_date: p.date_from, period_to: p.date_to,
      gross_sales: p.gross_sales, credit_total: p.credit_total,
      cash_total: d.cash ?? null, on_account: d.onAccount ?? null, debt_payments: d.debtPayments ?? null,
      debt_credit: d.debtCredit ?? null, cancel_amount: d.cancelAmount ?? null, cancel_count: d.cancelCount ?? null,
      txn_count: d.txnCount ?? null, cards: Array.isArray(d.cards) ? JSON.stringify(d.cards) : null,
      cash_count: d.cashCount ?? null, credit_count: d.creditCount ?? null, receipt_count: d.receiptCount ?? null,
      discount_amount: d.discountAmount ?? null, discount_count: d.discountCount ?? null,
      void_amount: d.voidAmount ?? null, void_count: d.voidCount ?? null,
    };
    return { ...row, checks: revenueChecks(row) };
  });
}

/** Day rows + period rows, newest first by the last day each covers. */
export async function listRevenueWithPeriods({ limit = 20, scope = null } = {}, x = getExecutor()) {
  const days = await listRevenue({ limit, scope }, x);
  const periods = await listRevenuePeriods({ limit, scope }, x);
  const end = (r) => r.period_to || r.report_date;
  return [...days, ...periods].sort((a, b) => String(end(b)).localeCompare(String(end(a)))).slice(0, limit);
}

/**
 * קליטה מרוכזת של דוחות פדיון — בעלים 20/10, בהגדרות ← סנכרון מהבנק: כמה קבצים בבת אחת, וכל קובץ נקלט לחנות
 * ששמה מודפס בו (`resolveStoreByTitle`). אותה קליטה כמו העלאה בדף רווחיות: דוח תקופתי → `importRevenuePeriod`
 * (שורה אחת, לא מפוצל), דוח יומי עם תאריך → `importRevenueRows`. קובץ בלי שם חנות (XLS — גם בלי תאריך) או ששמו לא
 * מצביע על חנות אחת בדיוק — נדחה עם הסבר, ולא מנוחש. כל קובץ עומד לבד: כשל באחד לא עוצר את האחרים.
 * @param {Array<{name:string, buffer:Buffer}>} files
 * @returns {Promise<Array<{file:string, ok:boolean, storeId?:number, text:string}>>}
 */
export async function importRevenueFiles(files, actor = null, x = getExecutor()) {
  const stores = await x.many('SELECT id, name FROM stores', []);
  const dm = (d) => String(d).split('-').reverse().join('/');
  const out = [];
  for (const f of files || []) {
    const file = f.name || 'קובץ';
    try {
      const parsed = await parseRevenueReportAny(f.buffer, {});
      if (!parsed.storeTitle) {
        out.push({ file, ok: false, text: `${file}: אין בקובץ שם חנות — העלה אותו בדף רווחיות כשהחנות שלו פעילה` });
        continue;
      }
      const store = resolveStoreByTitle(stores, parsed.storeTitle);
      if (!store) {
        out.push({ file, ok: false, text: `${file}: השם "${parsed.storeTitle}" לא מזהה חנות אחת — העלה אותו בדף רווחיות כשהחנות שלו פעילה` });
        continue;
      }
      if (parsed.kind === 'period') {
        const p = parsed.period;
        const { replaced } = await importRevenuePeriod(store.id, p, 'upload', actor, x);
        out.push({ file, ok: true, storeId: store.id,
          text: `${store.name}: ${dm(p.from)}–${dm(p.to)} · מכירות ${formatIls(p.gross)}${replaced.length ? ' (החליף דוח קודם)' : ''}` });
        continue;
      }
      if (!parsed.rows.length) {
        out.push({ file, ok: false, text: `${file}: לא נמצא תאריך בדוח — העלה אותו בדף רווחיות` });
        continue;
      }
      await importRevenueRows(store.id, parsed.rows, 'upload', actor, x);
      out.push({ file, ok: true, storeId: store.id,
        text: `${store.name}: ${parsed.rows.map((r) => dm(r.date)).join(', ')} · מכירות ${formatIls(parsed.rows.reduce((n, r) => n + (Number(r.gross) || 0), 0))}` });
    } catch (err) {
      if (!(err instanceof RuleError)) throw err;
      out.push({ file, ok: false, text: `${file}: ${err.message}` });
    }
  }
  return out;
}
