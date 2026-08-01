import { Router } from 'express';
import {
  outstandingChecks,
  outstandingChecksForAccount,
  invoiceLookup,
  profitability,
} from '../services/reports.js';
import path from 'node:path';
import fs from 'node:fs';
import {
  createZReport, deleteZReport, listZReports, missingZNumbers, getZReport,
  addExpense, listExpenses, expensesTotal, deleteExpense, getExpense, EXPENSE_TYPES,
  setDeposit, cashReconciliation, DENOMS,
  setCreditCards, ccReconciliation, CC_BRANDS,
  zReconciliationStatus,
} from '../services/zreports.js';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { toAgorot, fromAgorot } from '../lib/money.js';
import { toCsv } from '../lib/csvExport.js';
import { handleInvoiceImage } from '../middleware/upload.js';
import { RuleError } from '../lib/errors.js';

const router = Router();

function removeUpload(filename) {
  if (!filename) return;
  fs.rm(path.join(config.uploadsDir, path.basename(filename)), { force: true }, () => {});
}

function renderZReport(req, res, id, extra = {}) {
  const zr = getZReport(id);
  const store = getDb()
    .prepare('SELECT st.name AS store_name, c.name AS company_name FROM stores st JOIN companies c ON c.id = st.company_id WHERE st.id = ?')
    .get(zr.store_id);
  res.render('reports/zreport', {
    title: `דוח Z ${zr.z_number}`,
    zr,
    store,
    expenses: listExpenses(id),
    expensesTotal: expensesTotal(id),
    expenseTypes: EXPENSE_TYPES,
    denoms: DENOMS,
    depositCounts: zr.deposit_breakdown ? JSON.parse(zr.deposit_breakdown) : {},
    cashRecon: cashReconciliation(id),
    ccBrands: CC_BRANDS,
    ccRecon: ccReconciliation(id),
    zStatus: zReconciliationStatus(id),
    error: null,
    notice: null,
    ...extra,
  });
}

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
  const zReports = listZReports({ storeId: zStoreId, limit: 30 }).map((z) => {
    const status = zReconciliationStatus(z.id);
    return { ...z, matched: status.matched, issues: status.issues };
  });
  res.render('reports/profitability', {
    title: 'רווחיות',
    from,
    to,
    preset,
    stores,
    totals,
    storeOptions: storeList(),
    zReports,
    unmatchedCount: zReports.filter((z) => !z.matched).length,
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

// Z report detail (drawer + expenses; deposits/credit-card come in later sub-phases).
router.get('/zreports/:id', (req, res, next) => {
  try {
    renderZReport(req, res, Number(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Add a drawer-expense line (with optional note image).
router.post('/zreports/:id/expenses', handleInvoiceImage, (req, res, next) => {
  const id = Number(req.params.id);
  try {
    if (req.uploadError) {
      if (req.file) removeUpload(req.file.filename);
      return renderZReport(req, res, id, { error: req.uploadError });
    }
    addExpense(
      id,
      {
        expenseDate: req.body.expense_date || null,
        payerName: req.body.payer_name,
        descriptionType: req.body.description_type,
        employeeName: req.body.employee_name,
        amount: toAgorot(req.body.amount),
        imagePath: req.file ? req.file.filename : null,
      },
      req.user,
    );
    renderZReport(req, res, id, { notice: 'הוצאה נוספה.' });
  } catch (err) {
    if (req.file) removeUpload(req.file.filename);
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

// Save the deposit (bill counts + bag number) for a Z report.
router.post('/zreports/:id/deposit', (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const counts = {};
    for (const d of DENOMS) counts[d.value] = Number(req.body[`count_${d.key}`] || 0);
    setDeposit(id, { counts, bag: req.body.deposit_bag }, req.user);
    renderZReport(req, res, id, { notice: 'הפקדה נשמרה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

// Save the credit-card report (per-brand amounts) for a Z report.
router.post('/zreports/:id/creditcards', (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const amounts = {};
    for (const b of CC_BRANDS) amounts[b.key] = toAgorot(req.body[`cc_${b.key}`]);
    setCreditCards(id, { amounts }, req.user);
    renderZReport(req, res, id, { notice: 'דוח אשראי נשמר.' });
  } catch (err) {
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

// Serve an expense note image.
router.get('/zexpenses/:id/image', (req, res, next) => {
  try {
    const e = getExpense(Number(req.params.id));
    if (!e.image_path) return res.status(404).send('אין תמונה');
    return res.sendFile(path.join(config.uploadsDir, path.basename(e.image_path)));
  } catch (err) {
    next(err);
  }
});

router.post('/zexpenses/:id/delete', (req, res, next) => {
  try {
    const removed = deleteExpense(Number(req.params.id), req.user);
    if (removed.image_path) removeUpload(removed.image_path);
    renderZReport(req, res, removed.z_report_id, { notice: 'הוצאה נמחקה.' });
  } catch (err) {
    next(err);
  }
});

export default router;
