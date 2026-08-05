import { Router } from 'express';
import {
  outstandingChecks,
  outstandingChecksForAccount,
  outstandingCheckDetail,
  invoiceLookup,
  profitability,
} from '../services/reports.js';
import {
  createZReport, deleteZReport, listZReports, missingZNumbers, getZReport,
  addExpense, listExpenses, expensesTotal, deleteExpense, getExpense, EXPENSE_TYPES,
  replaceExpenses, setZReportImage, previousZReport,
  setDeposit, cashReconciliation, DENOMS,
  setCreditCards, ccReconciliation, CC_BRANDS,
  zReconciliationStatus,
} from '../services/zreports.js';
import { createDeposit, listDeposits, setDeposited, deleteDeposit, depositTotalForZ } from '../services/deposits.js';
import { listInvoices } from '../services/invoices.js';
import { getExecutor } from '../db/adapter.js';
import { toAgorot, fromAgorot } from '../lib/money.js';
import { toCsv } from '../lib/csvExport.js';
import { handleInvoiceImage } from '../middleware/upload.js';
import { getObject, del as removeStored } from '../lib/storage.js';
import { notify } from '../lib/notify.js';
import { requirePageAccess } from '../middleware/requireOwner.js';
import { RuleError } from '../lib/errors.js';
import { scopeParam } from '../lib/scopeGuard.js';

const router = Router();

// Company-separation guards on every id-bearing route (Z reports, deposits, expense images).
// Each prefix resolves the entity's owning company and 404s when it's outside the caller's scope.
router.use('/zreports/:id', scopeParam('zreport'));
router.use('/deposits/:id', scopeParam('deposit'));
router.use('/zexpenses/:id', scopeParam('expense'));

function removeUpload(ref) {
  if (ref) void removeStored(ref);
}

function zUrl(req, id) {
  return `${req.protocol}://${req.get('host')}/reports/zreports/${id}`;
}

function ils(agorot) {
  return `₪${fromAgorot(agorot)}`;
}

// Recent invoices offered as match targets for a cash expense (מס' · ספק · סכום). Scoped, capped.
async function invoicePickOptions(scope) {
  const rows = await listInvoices({ scope });
  return rows.slice(0, 300).map((r) => ({
    id: r.id,
    invoice_number: r.invoice_number,
    supplier_name: r.supplier_name,
    total_amount: r.total_amount,
  }));
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

// WhatsApp summary text for the cash discrepancy (the diff between drawer cash and
// deposit+expenses), referencing the previous Z's date+time as the period start.
function zWhatsappText(zr, cashRecon, prevZ) {
  const diff = cashRecon.diff;
  const head = `Z מס ${zr.z_number} מתאריך ${zr.z_date}`;
  const body = diff === 0 ? 'מאוזן ✓' : `${diff < 0 ? 'חוסר' : 'פלוס'} ע"ס ₪${fromAgorot(Math.abs(diff))}`;
  const prev = prevZ
    ? `\nמתאריך Z קודם: ${prevZ.z_date}${prevZ.created_at ? ' ' + String(prevZ.created_at).slice(11, 16) : ''} (Z מס ${prevZ.z_number})`
    : '';
  return `${head}\n${body}${prev}`;
}

// WhatsApp status for a Z in the "רשומות Z אחרונות" list, per the owner's rule:
// base = סה"כ מגירה + הוצאות במזומן, compared to סכום ההפקדה (הצהרה על הפקדה).
// equal → תואם; base < deposit → חוסר <diff>; base > deposit → יתרה <diff>.
function zDepositWhatsappText(zr, depDiff) {
  const head = `זד מס ${zr.z_number} מתאריך : ${zr.z_date}`;
  const status =
    depDiff === 0 ? 'סטטוס: תואם' : depDiff > 0 ? `סטטוס: יתרה ${ils(depDiff)}` : `סטטוס: חוסר ${ils(-depDiff)}`;
  return `${head}\n${status}`;
}

async function renderZReport(req, res, id, extra = {}) {
  const zr = await getZReport(id);
  const store = await getExecutor().one(
    'SELECT st.name AS store_name, c.name AS company_name FROM stores st JOIN companies c ON c.id = st.company_id WHERE st.id = ?',
    [zr.store_id],
  );
  const cashRecon = await cashReconciliation(id);
  const prevZ = await previousZReport(zr);
  res.render('reports/zreport', {
    title: `דוח Z ${zr.z_number}`,
    zr,
    store,
    expenses: await listExpenses(id),
    expensesTotal: await expensesTotal(id),
    expenseTypes: EXPENSE_TYPES,
    invoiceOptions: await invoicePickOptions(req.scope.companyIds),
    denoms: DENOMS,
    depositCounts: zr.deposit_breakdown ? JSON.parse(zr.deposit_breakdown) : {},
    cashRecon,
    prevZ,
    waText: zWhatsappText(zr, cashRecon, prevZ),
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
  const q = (k) => req.query[k] || req.body?.[k];
  const preset = q('preset');
  const now = new Date();
  // The chosen week/month is anchored on `from` (any day inside it) when provided, else "now".
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(q('from') || '') ? new Date(`${q('from')}T00:00:00`) : now;
  if (preset === 'week') {
    const sunday = new Date(anchor);
    sunday.setDate(anchor.getDate() - anchor.getDay());
    const saturday = new Date(sunday);
    saturday.setDate(sunday.getDate() + 6);
    return { from: ymd(sunday), to: ymd(saturday), preset: 'week' };
  }
  if (preset === 'month' || !q('from')) {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { from: ymd(first), to: ymd(last), preset: preset === 'month' ? 'month' : '' };
  }
  return { from: q('from'), to: q('to'), preset: '' };
}

async function storeList() {
  return getExecutor().many(
    `SELECT st.id, st.name, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id ORDER BY c.name, st.name`,
    [],
  );
}

async function renderProfitability(req, res, extra = {}) {
  const { from, to, preset } = resolveRange(req);
  const { stores, totals } = await profitability(from, to, req.scope.companyIds);
  res.render('reports/profitability', {
    title: 'רווחיות',
    from,
    to,
    preset,
    stores,
    totals,
    error: null,
    notice: null,
    ...extra,
  });
}

// Z reports live on their own tab (form to add + recent records table).
async function renderZReports(req, res, extra = {}) {
  const zStoreId = req.query.zstore ? Number(req.query.zstore) : null;
  const zRows = await listZReports({ storeId: zStoreId, limit: 30 });
  const zReports = await Promise.all(
    zRows.map(async (z) => {
      const status = await zReconciliationStatus(z.id);
      // WhatsApp status (per the owner's rule): (סה"כ מגירה + הוצאות במזומן) מול סכום ההפקדה.
      const expenses = await expensesTotal(z.id);
      const deposit = await depositTotalForZ(z.id);
      const base = (z.drawer_total || 0) + expenses;
      const depDiff = base - deposit;
      const waText = zDepositWhatsappText(z, depDiff);
      return { ...z, matched: status.matched, issues: status.issues, expensesTotal: expenses, depositTotal: deposit, depDiff, waText };
    }),
  );
  res.render('reports/zreports', {
    title: 'דוחות Z',
    storeOptions: await storeList(),
    zReports,
    unmatchedCount: zReports.filter((z) => !z.matched).length,
    zStoreId,
    missingZ: zStoreId ? await missingZNumbers(zStoreId) : [],
    deposits: await listDeposits({ storeId: zStoreId, scope: req.scope.companyIds }),
    invoiceOptions: await invoicePickOptions(req.scope.companyIds),
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/zreports', requirePageAccess('nav_zreports'), async (req, res, next) => {
  try {
    await renderZReports(req, res);
  } catch (err) {
    next(err);
  }
});

// Deposit declarations (הצהרה על הפקדה) — created together with a Z report (POST /zreports).
router.post('/deposits/:id/deposited', async (req, res, next) => {
  try {
    await setDeposited(Number(req.params.id), req.body.value === '1', req.user);
    res.redirect(303, req.get('referer') || '/reports/zreports');
  } catch (err) {
    next(err);
  }
});

router.post('/deposits/:id/delete', async (req, res, next) => {
  try {
    await deleteDeposit(Number(req.params.id), req.user);
    res.redirect(303, req.get('referer') || '/reports/zreports');
  } catch (err) {
    next(err);
  }
});

// §7 "צ׳קים בחוץ"
router.get('/outstanding', requirePageAccess('nav_outstanding'), async (req, res, next) => {
  try {
    const { accounts, totalOutstanding } = await outstandingChecks(req.scope.companyIds);
    const detailAccountId = req.query.account ? Number(req.query.account) : null;
    // Scope guard: only show detail for an account the user is allowed to see.
    const inScope = detailAccountId != null && accounts.some((a) => a.id === detailAccountId);
    res.render('reports/outstanding', {
      title: 'צ׳קים בחוץ',
      accounts,
      totalOutstanding,
      detailAccountId: inScope ? detailAccountId : null,
      detail: inScope ? await outstandingCheckDetail(detailAccountId) : [],
    });
  } catch (err) {
    next(err);
  }
});

// Detailed per-store CSV — one row per open check with invoice/credit breakdown.
router.get('/outstanding-detail.csv', async (req, res, next) => {
  try {
    const accountId = Number(req.query.account);
    const { accounts } = await outstandingChecks(req.scope.companyIds);
    if (!accounts.some((a) => a.id === accountId)) { res.status(404).send('not found'); return; }
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
    const { accounts } = await outstandingChecks(req.scope.companyIds);
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
      results: q ? await invoiceLookup(q, { scope: req.scope.companyIds }) : [],
    });
  } catch (err) {
    next(err);
  }
});

// CSV export — "בדיקת חשבונית"
router.get('/lookup.csv', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    const results = q ? await invoiceLookup(q, { scope: req.scope.companyIds }) : [];
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

// §7 "רווחיות"
router.get('/profitability', requirePageAccess('nav_profitability'), async (req, res, next) => {
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
    const created = await createZReport(
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
    // Optional cash-expense lines entered on the same form (itemized "הוצאות במזומן").
    {
      const dates = [].concat(b.expense_date || []);
      const names = [].concat(b.payer_name || []);
      const purposes = [].concat(b.purpose || []);
      const amounts = [].concat(b.amount || []);
      const invoiceIds = [].concat(b.expense_invoice_id || []);
      const rows = amounts.map((a, i) => ({
        expenseDate: dates[i] || null,
        payerName: names[i],
        purpose: purposes[i],
        amount: a != null && String(a).trim() !== '' ? toAgorot(a) : 0,
        invoiceId: invoiceIds[i] || null,
      }));
      if (rows.some((r) => (r.payerName || '').trim() || (r.purpose || '').trim() || r.amount || r.invoiceId)) {
        await replaceExpenses(created.id, rows, req.user);
      }
    }
    // Optional deposit declaration entered on the same form — reuses the Z's store + date,
    // and links back to the Z it was declared on.
    if ((b.dep_bag || '').trim() || (b.dep_amount || '').trim()) {
      await createDeposit(
        {
          storeId,
          zReportId: created.id,
          depositDate: b.z_date,
          bagNumber: b.dep_bag,
          amount: toAgorot(b.dep_amount || '0'),
          deposited: b.dep_deposited === '1' || b.dep_deposited === 'on',
        },
        req.user,
      );
    }
    // §2a: every time Z reports are entered, remind about any gap in the sequence.
    try {
      const missing = await missingZNumbers(storeId);
      if (missing.length) {
        notify(`🔢 <b>מספר Z חסר ברצף</b>\nחסרים: ${missing.join(', ')}\n${req.protocol}://${req.get('host')}/reports/zreports?zstore=${storeId}`);
      }
    } catch { /* best-effort */ }
    // Cash-gap alert on the create path: מזומן מגירה vs הפקדה + הוצאות. The individual-view edit
    // routes already alert via alertIfUnmatched; this covers the "created in one go" path.
    try {
      const cr = await cashReconciliation(created.id);
      if (cr.diff !== 0) {
        const label = cr.diff < 0 ? 'חוסר' : 'יתרה';
        notify(`⚠️ <b>פער מזומן ב-Z ${b.z_number}</b>\n${label} ע"ס ${ils(Math.abs(cr.diff))}\nמזומן מגירה ${ils(cr.cash)} = הפקדה ${ils(cr.deposit)} + הוצאות ${ils(cr.expenses)}\n${zUrl(req, created.id)}`);
      }
    } catch { /* best-effort */ }
    await renderZReports(req, res, { notice: 'דוח Z נוסף.' });
  } catch (err) {
    if (err instanceof RuleError) return renderZReports(req, res, { error: err.message });
    next(err);
  }
});

router.post('/zreports/:id/delete', async (req, res, next) => {
  try {
    await deleteZReport(Number(req.params.id), req.user);
    await renderZReports(req, res, { notice: 'דוח Z נמחק.' });
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

// "סכם" — replace ALL cash-expense lines at once from the collapsible table.
router.post('/zreports/:id/expenses-bulk', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const dates = [].concat(req.body.expense_date || []);
    const names = [].concat(req.body.payer_name || []);
    const purposes = [].concat(req.body.purpose || []);
    const amounts = [].concat(req.body.amount || []);
    const invoiceIds = [].concat(req.body.expense_invoice_id || []);
    const rows = amounts.map((a, i) => ({
      expenseDate: dates[i] || null,
      payerName: names[i],
      purpose: purposes[i],
      amount: a != null && String(a).trim() !== '' ? toAgorot(a) : 0,
      invoiceId: invoiceIds[i] || null,
    }));
    await replaceExpenses(id, rows, req.user);
    await alertIfUnmatched(req, id);
    await renderZReport(req, res, id, { notice: 'ההוצאות נשמרו.' });
  } catch (err) {
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

// Upload a scan of the printed Z slip (one image per Z report).
router.post('/zreports/:id/image', handleInvoiceImage, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    if (req.uploadError) {
      if (req.file) removeUpload(req.file.filename);
      return renderZReport(req, res, id, { error: req.uploadError });
    }
    if (!req.file) return renderZReport(req, res, id, { error: 'לא נבחר קובץ.' });
    const prev = await getZReport(id);
    await setZReportImage(id, req.file.filename, req.user);
    if (prev.image_path) removeUpload(prev.image_path);
    await renderZReport(req, res, id, { notice: 'תמונת הדוח נשמרה.' });
  } catch (err) {
    if (req.file) removeUpload(req.file.filename);
    next(err);
  }
});

// Serve the Z-slip scan.
router.get('/zreports/:id/image', async (req, res, next) => {
  try {
    const zr = await getZReport(Number(req.params.id));
    if (!zr.image_path) return res.status(404).send('אין תמונה');
    const { buffer, contentType } = await getObject(zr.image_path);
    return res.type(contentType).send(buffer);
  } catch (err) {
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
