import { Router } from 'express';
import {
  outstandingChecks,
  outstandingChecksForAccount,
  invoiceLookup,
  profitability,
} from '../services/reports.js';
import { createZReport, deleteZReport, listZReports, missingZNumbers } from '../services/zreports.js';
import { getDb } from '../db/index.js';
import { toAgorot, fromAgorot } from '../lib/money.js';
import { toCsv } from '../lib/csvExport.js';
import { RuleError } from '../lib/errors.js';

const router = Router();

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Date presets: month (1st..last), week (Sun..Sat of the current week), or explicit from/to.
function resolveRange(req) {
  const preset = req.query.preset || req.body?.preset;
  const now = new Date();
  if (preset === 'week') {
    const sunday = new Date(now);
    sunday.setDate(now.getDate() - now.getDay()); // getDay: 0=Sun
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    return { from: ymd(sunday), to: ymd(saturday), preset: 'week' };
  }
  if (preset === 'month' || (!req.query.from && !req.body?.from)) {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: ymd(first), to: ymd(last), preset: 'month' };
  }
  return { from: req.query.from || req.body?.from, to: req.query.to || req.body?.to, preset: '' };
}

function storeList() {
  return getDb()
    .prepare(
      `SELECT st.id, st.name, c.name AS company_name
         FROM stores st JOIN companies c ON c.id = st.company_id ORDER BY c.name, st.name`,
    )
    .all();
}

function renderProfitability(req, res, extra = {}) {
  const { from, to, preset } = resolveRange(req);
  const { stores, totals } = profitability(from, to);
  const zStoreId = req.query.zstore ? Number(req.query.zstore) : null;
  res.render('reports/profitability', {
    title: 'רווחיות',
    from,
    to,
    preset,
    stores,
    totals,
    storeOptions: storeList(),
    zReports: listZReports({ storeId: zStoreId, limit: 30 }),
    zStoreId,
    missingZ: zStoreId ? missingZNumbers(zStoreId) : [],
    error: null,
    notice: null,
    ...extra,
  });
}

// §7 "צ׳קים בחוץ"
router.get('/outstanding', (req, res) => {
  const { accounts, totalOutstanding } = outstandingChecks();
  const detailAccountId = req.query.account ? Number(req.query.account) : null;
  res.render('reports/outstanding', {
    title: 'צ׳קים בחוץ',
    accounts,
    totalOutstanding,
    detailAccountId,
    detailChecks: detailAccountId ? outstandingChecksForAccount(detailAccountId) : [],
  });
});

function sendCsv(res, filename, headers, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(headers, rows));
}

// CSV export — "צ׳קים בחוץ"
router.get('/outstanding.csv', (req, res) => {
  const { accounts } = outstandingChecks();
  const rows = accounts.map((a) => [a.company_name, a.store_name, a.display_name, a.outstanding_count, fromAgorot(a.outstanding)]);
  sendCsv(res, 'outstanding-checks.csv', ['חברה', 'חנות', 'חשבון', 'מס׳ צ׳קים פתוחים', 'סכום בחוץ'], rows);
});

// §7 "בדיקת חשבונית"
router.get('/lookup', (req, res) => {
  const q = req.query.q || '';
  res.render('reports/lookup', {
    title: 'בדיקת חשבונית',
    query: q,
    results: q ? invoiceLookup(q) : [],
  });
});

// CSV export — "בדיקת חשבונית"
router.get('/lookup.csv', (req, res) => {
  const q = req.query.q || '';
  const results = q ? invoiceLookup(q) : [];
  const rows = results.map((r) => [
    r.id, r.supplier_name, r.store_name, r.invoice_number, r.allocation_number || '',
    r.invoice_date, fromAgorot(r.total_amount), r.invoice_status, r.check_number || '', r.payment_status || '',
  ]);
  sendCsv(
    res,
    'invoice-lookup.csv',
    ['#', 'ספק', 'חנות', 'מס׳ חשבונית', 'הקצאה', 'תאריך', 'סכום', 'סטטוס', 'מס׳ צ׳ק', 'פירעון'],
    rows,
  );
});

// §7 "רווחיות"
router.get('/profitability', (req, res) => {
  renderProfitability(req, res);
});

// CSV export — "רווחיות"
router.get('/profitability.csv', (req, res) => {
  const { from, to } = resolveRange(req);
  const { stores, totals } = profitability(from, to);
  const pct = (v) => (v == null ? '' : `${v.toFixed(1)}%`);
  const rows = stores.map((s) => [
    s.company_name, s.store_name, fromAgorot(s.purchases), fromAgorot(s.sales),
    fromAgorot(s.grossProfit), pct(s.marginPct), pct(s.markupPct),
  ]);
  rows.push(['', 'סה"כ', fromAgorot(totals.purchases), fromAgorot(totals.sales), fromAgorot(totals.grossProfit), pct(totals.marginPct), pct(totals.markupPct)]);
  sendCsv(res, `profitability-${from}_${to}.csv`, ['חברה', 'חנות', 'קניות', 'מכירות', 'רווח גולמי', 'רווח מלמעלה (% מהמכירות)', 'רווח מלמטה (% מהעלות)'], rows);
});

// Add a Z report (יומי Z + drawer breakdown), then re-render.
router.post('/zreports', (req, res, next) => {
  const b = req.body;
  try {
    createZReport(
      {
        storeId: Number(b.store_id),
        zNumber: b.z_number,
        zDate: b.z_date,
        dailyTotal: toAgorot(b.daily_total),
        drawerCash: toAgorot(b.drawer_cash),
        drawerCheck: toAgorot(b.drawer_check),
        drawerCredit: toAgorot(b.drawer_credit),
        drawerHakafa: toAgorot(b.drawer_hakafa),
        drawerVouchers: toAgorot(b.drawer_vouchers),
      },
      req.user,
    );
    renderProfitability(req, res, { notice: 'דוח Z נוסף.' });
  } catch (err) {
    if (err instanceof RuleError) return renderProfitability(req, res, { error: err.message });
    next(err);
  }
});

router.post('/zreports/:id/delete', (req, res, next) => {
  try {
    deleteZReport(Number(req.params.id), req.user);
    renderProfitability(req, res, { notice: 'דוח Z נמחק.' });
  } catch (err) {
    next(err);
  }
});

export default router;
