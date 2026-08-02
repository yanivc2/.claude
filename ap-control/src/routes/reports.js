import { Router } from 'express';
import {
  outstandingChecks,
  outstandingChecksForAccount,
  outstandingCheckDetail,
  invoiceLookup,
  profitability,
  purchasesReport,
} from '../services/reports.js';
import {
  createZReport, deleteZReport, listZReports, missingZNumbers, getZReport,
  addExpense, listExpenses, expensesTotal, deleteExpense, getExpense, EXPENSE_TYPES,
  setDeposit, cashReconciliation, DENOMS,
  setCreditCards, ccReconciliation, CC_BRANDS,
  zReconciliationStatus,
} from '../services/zreports.js';
import { getExecutor } from '../db/adapter.js';
import { toAgorot, fromAgorot } from '../lib/money.js';
import { toCsv } from '../lib/csvExport.js';
import { handleInvoiceImage } from '../middleware/upload.js';
import { getObject, del as removeStored } from '../lib/storage.js';
import { notify } from '../lib/notify.js';
import { RuleError } from '../lib/errors.js';

const router = Router();

function removeUpload(ref) {
  if (ref) void removeStored(ref);
}

function zUrl(req, id) {
  return `${req.protocol}://${req.get('host')}/reports/zreports/${id}`;
}

function ils(agorot) {
  return `₪${fromAgorot(agorot)}`;
}

// Fire a Telegram alert if a Z report is unmatched after a save. Best-effort — never throws.
async function alertIfUnmatched(req, id) {
  try {
    const st = await zReconciliationStatus(id);
    if (st.matched) return;
    const zr = await getZReport(id);
    const lines = st.issues.map((i) => `• ${i.label}: ${ils(i.diff)}`);
    notify(`⚠️ <b>Z לא תואם</b>\nדוח Z ${zr.z_number}\n${lines.join('\n')}\n${zUrl(req, id)}`);
  } catch {
    /* alerts are best-effort */
  }
}

async function renderZReport(req, res, id, extra = {}) {
  const zr = await getZReport(id);
  const store = await getExecutor().one(
    'SELECT st.name AS store_name, c.name AS company_name FROM stores st JOIN companies c ON c.id = st.company_id WHERE st.id = ?',
    [zr.store_id],
  );
  res.render('reports/zreport', {
    title: `דוח Z ${zr.z_number}`,
    zr,
    store,
    expenses: await listExpenses(id),
    expensesTotal: await expensesTotal(id),
    expenseTypes: EXPENSE_TYPES,
    denoms: DENOMS,
    depositCounts: zr.deposit_breakdown ? JSON.parse(zr.deposit_breakdown) : {},
    cashRecon: await cashReconciliation(id),
    ccBrands: CC_BRANDS,
    ccRecon: await ccReconciliation(id),
    zStatus: await zReconciliationStatus(id),
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
    sunday.setDate(now.getDate() - now.getDay());
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

async function storeList() {
  return getExecutor().many(
    `SELECT st.id, st.name, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id ORDER BY c.name, st.name`,
    [],
  );
}

async function supplierList() {
  return getExecutor().many('SELECT id, name FROM suppliers ORDER BY name', []);
}

// Read the purchases-report filters from the query string.
function purchaseFilters(req) {
  return {
    from: req.query.from || null,
    to: req.query.to || null,
    supplierId: req.query.supplier ? Number(req.query.supplier) : null,
    storeId: req.query.store ? Number(req.query.store) : null,
  };
}

async function renderProfitability(req, res, extra = {}) {
  const { from, to, preset } = resolveRange(req);
  const { stores, totals } = await profitability(from, to);
  const zStoreId = req.query.zstore ? Number(req.query.zstore) : null;
  const zRows = await listZReports({ storeId: zStoreId, limit: 30 });
  const zReports = await Promise.all(
    zRows.map(async (z) => {
      const status = await zReconciliationStatus(z.id);
      return { ...z, matched: status.matched, issues: status.issues };
    }),
  );
  res.render('reports/profitability', {
    title: 'רווחיות',
    from,
    to,
    preset,
    stores,
    totals,
    storeOptions: await storeList(),
    zReports,
    unmatchedCount: zReports.filter((z) => !z.matched).length,
    zStoreId,
    missingZ: zStoreId ? await missingZNumbers(zStoreId) : [],
    error: null,
    notice: null,
    ...extra,
  });
}

// §7 "צ׳קים בחוץ"
router.get('/outstanding', async (req, res, next) => {
  try {
    const { accounts, totalOutstanding } = await outstandingChecks();
    const detailAccountId = req.query.account ? Number(req.query.account) : null;
    res.render('reports/outstanding', {
      title: 'צ׳קים בחוץ',
      accounts,
      totalOutstanding,
      detailAccountId,
      detail: detailAccountId ? await outstandingCheckDetail(detailAccountId) : [],
    });
  } catch (err) {
    next(err);
  }
});

// Detailed per-store CSV — one row per open check with invoice/credit breakdown.
router.get('/outstanding-detail.csv', async (req, res, next) => {
  try {
    const accountId = Number(req.query.account);
    const rows = (await outstandingCheckDetail(accountId)).map((r) => [
      r.supplierName,
      r.invoiceNumbers,
      r.invoiceDate,
      fromAgorot(r.invoiceAmount),
      r.creditNumbers || '',
      r.creditAmount ? fromAgorot(r.creditAmount) : '',
      r.dueDate,
      fromAgorot(r.amount),
    ]);
    sendCsv(
      res,
      `outstanding-detail-account-${accountId}.csv`,
      ['ספק', 'מס׳ חשבונית', 'תאריך חשבונית', 'סכום חשבונית', 'מס׳ חשבונית זיכוי', 'סכום זיכוי', 'תאריך פירעון', 'סכום'],
      rows,
    );
  } catch (err) {
    next(err);
  }
});

function sendCsv(res, filename, headers, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(toCsv(headers, rows));
}

// CSV export — "צ׳קים בחוץ"
router.get('/outstanding.csv', async (req, res, next) => {
  try {
    const { accounts } = await outstandingChecks();
    const rows = accounts.map((a) => [a.company_name, a.store_name, a.display_name, a.outstanding_count, fromAgorot(a.outstanding)]);
    sendCsv(res, 'outstanding-checks.csv', ['חברה', 'חנות', 'חשבון', 'מס׳ צ׳קים פתוחים', 'סכום בחוץ'], rows);
  } catch (err) {
    next(err);
  }
});

// §7 "בדיקת חשבונית"
router.get('/lookup', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    res.render('reports/lookup', {
      title: 'בדיקת חשבונית',
      query: q,
      results: q ? await invoiceLookup(q) : [],
    });
  } catch (err) {
    next(err);
  }
});

// CSV export — "בדיקת חשבונית"
router.get('/lookup.csv', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    const results = q ? await invoiceLookup(q) : [];
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
  } catch (err) {
    next(err);
  }
});

// רכש — purchases report (invoices by supplier/store/date).
router.get('/purchases', async (req, res, next) => {
  try {
    const f = purchaseFilters(req);
    const { rows, bySupplier, total, count } = await purchasesReport(f);
    res.render('reports/purchases', {
      title: 'רכש',
      filters: f,
      rows,
      bySupplier,
      total,
      count,
      suppliers: await supplierList(),
      stores: await storeList(),
    });
  } catch (err) {
    next(err);
  }
});

// CSV export — רכש
router.get('/purchases.csv', async (req, res, next) => {
  try {
    const { rows } = await purchasesReport(purchaseFilters(req));
    const body = rows.map((r) => [
      r.id, r.invoice_date, r.supplier_name, r.store_name, r.invoice_number,
      r.allocation_number || '', fromAgorot(r.total_amount), r.doc_type, r.status,
    ]);
    sendCsv(
      res,
      'purchases.csv',
      ['#', 'תאריך', 'ספק', 'חנות', 'מס׳ חשבונית', 'הקצאה', 'סכום', 'סוג', 'סטטוס'],
      body,
    );
  } catch (err) {
    next(err);
  }
});

// §7 "רווחיות"
router.get('/profitability', async (req, res, next) => {
  try {
    await renderProfitability(req, res);
  } catch (err) {
    next(err);
  }
});

// CSV export — "רווחיות"
router.get('/profitability.csv', async (req, res, next) => {
  try {
    const { from, to } = resolveRange(req);
    const { stores, totals } = await profitability(from, to);
    const pct = (v) => (v == null ? '' : `${v.toFixed(1)}%`);
    const rows = stores.map((s) => [
      s.company_name, s.store_name, fromAgorot(s.purchases), fromAgorot(s.sales),
      fromAgorot(s.grossProfit), pct(s.marginPct), pct(s.markupPct),
    ]);
    rows.push(['', 'סה"כ', fromAgorot(totals.purchases), fromAgorot(totals.sales), fromAgorot(totals.grossProfit), pct(totals.marginPct), pct(totals.markupPct)]);
    sendCsv(res, `profitability-${from}_${to}.csv`, ['חברה', 'חנות', 'קניות', 'מכירות', 'רווח גולמי', 'רווח מלמעלה (% מהמכירות)', 'רווח מלמטה (% מהעלות)'], rows);
  } catch (err) {
    next(err);
  }
});

// Add a Z report (יומי Z + drawer breakdown), then re-render.
router.post('/zreports', async (req, res, next) => {
  const b = req.body;
  try {
    const storeId = Number(b.store_id);
    await createZReport(
      {
        storeId,
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
    // §2a: every time Z reports are entered, remind about any gap in the sequence.
    try {
      const missing = await missingZNumbers(storeId);
      if (missing.length) {
        notify(`🔢 <b>מספר Z חסר ברצף</b>\nחסרים: ${missing.join(', ')}\n${req.protocol}://${req.get('host')}/reports/profitability?zstore=${storeId}`);
      }
    } catch { /* best-effort */ }
    await renderProfitability(req, res, { notice: 'דוח Z נוסף.' });
  } catch (err) {
    if (err instanceof RuleError) return renderProfitability(req, res, { error: err.message });
    next(err);
  }
});

router.post('/zreports/:id/delete', async (req, res, next) => {
  try {
    await deleteZReport(Number(req.params.id), req.user);
    await renderProfitability(req, res, { notice: 'דוח Z נמחק.' });
  } catch (err) {
    next(err);
  }
});

// Z report detail.
router.get('/zreports/:id', async (req, res, next) => {
  try {
    await renderZReport(req, res, Number(req.params.id));
  } catch (err) {
    next(err);
  }
});

// Add a drawer-expense line (with optional note image).
router.post('/zreports/:id/expenses', handleInvoiceImage, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    if (req.uploadError) {
      if (req.file) removeUpload(req.file.filename);
      return renderZReport(req, res, id, { error: req.uploadError });
    }
    await addExpense(
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
    await alertIfUnmatched(req, id);
    await renderZReport(req, res, id, { notice: 'הוצאה נוספה.' });
  } catch (err) {
    if (req.file) removeUpload(req.file.filename);
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

// Save the deposit (bill counts + bag number) for a Z report.
router.post('/zreports/:id/deposit', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const counts = {};
    for (const d of DENOMS) counts[d.value] = Number(req.body[`count_${d.key}`] || 0);
    await setDeposit(id, { counts, bag: req.body.deposit_bag }, req.user);
    await alertIfUnmatched(req, id);
    await renderZReport(req, res, id, { notice: 'הפקדה נשמרה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

// Save the credit-card report (per-brand amounts) for a Z report.
router.post('/zreports/:id/creditcards', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const amounts = {};
    for (const b of CC_BRANDS) amounts[b.key] = toAgorot(req.body[`cc_${b.key}`]);
    await setCreditCards(id, { amounts }, req.user);
    await alertIfUnmatched(req, id);
    await renderZReport(req, res, id, { notice: 'דוח אשראי נשמר.' });
  } catch (err) {
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

// Serve an expense note image.
router.get('/zexpenses/:id/image', async (req, res, next) => {
  try {
    const e = await getExpense(Number(req.params.id));
    if (!e.image_path) return res.status(404).send('אין תמונה');
    const { buffer, contentType } = await getObject(e.image_path);
    return res.type(contentType).send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post('/zexpenses/:id/delete', async (req, res, next) => {
  try {
    const removed = await deleteExpense(Number(req.params.id), req.user);
    if (removed.image_path) removeUpload(removed.image_path);
    await renderZReport(req, res, removed.z_report_id, { notice: 'הוצאה נמחקה.' });
  } catch (err) {
    next(err);
  }
});

export default router;
