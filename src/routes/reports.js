import { Router } from 'express';
import {
  outstandingChecks,
  outstandingChecksForAccount,
  invoiceLookup,
  profitability,
} from '../services/reports.js';
import { addSalesEntry, deleteSalesEntry, listSalesEntries } from '../services/sales.js';
import { getDb } from '../db/index.js';
import { toAgorot, fromAgorot } from '../lib/money.js';
import { toCsv } from '../lib/csvExport.js';
import { RuleError } from '../lib/errors.js';

const router = Router();

// Default the profitability range to the current calendar month.
function defaultRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const last = new Date(y, now.getMonth() + 1, 0).getDate();
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${String(last).padStart(2, '0')}` };
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
  const def = defaultRange();
  const from = req.query.from || req.body?.from || def.from;
  const to = req.query.to || req.body?.to || def.to;
  const { stores, totals } = profitability(from, to);
  res.render('reports/profitability', {
    title: 'רווחיות',
    from,
    to,
    stores,
    totals,
    storeOptions: storeList(),
    salesEntries: listSalesEntries(30),
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
  const def = defaultRange();
  const from = req.query.from || def.from;
  const to = req.query.to || def.to;
  const { stores, totals } = profitability(from, to);
  const rows = stores.map((s) => [
    s.company_name, s.store_name, fromAgorot(s.purchases), fromAgorot(s.sales),
    fromAgorot(s.grossProfit), s.marginPct == null ? '' : `${s.marginPct.toFixed(1)}%`,
  ]);
  rows.push(['', 'סה"כ', fromAgorot(totals.purchases), fromAgorot(totals.sales), fromAgorot(totals.grossProfit), totals.marginPct == null ? '' : `${totals.marginPct.toFixed(1)}%`]);
  sendCsv(res, `profitability-${from}_${to}.csv`, ['חברה', 'חנות', 'קניות', 'מכירות', 'רווח גולמי', '% רווח'], rows);
});

// Add a register (Z) sales entry, then re-render the report.
router.post('/sales', (req, res, next) => {
  try {
    addSalesEntry(
      {
        storeId: Number(req.body.store_id),
        saleDate: req.body.sale_date,
        amount: toAgorot(req.body.amount),
        notes: req.body.notes || null,
      },
      req.user,
    );
    renderProfitability(req, res, { notice: 'רשומת מכירות נוספה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderProfitability(req, res, { error: err.message });
    next(err);
  }
});

router.post('/sales/:id/delete', (req, res, next) => {
  try {
    deleteSalesEntry(Number(req.params.id), req.user);
    renderProfitability(req, res, { notice: 'רשומת מכירות נמחקה.' });
  } catch (err) {
    next(err);
  }
});

export default router;
