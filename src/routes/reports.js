import { Router } from 'express';
import {
  outstandingChecks,
  outstandingChecksForAccount,
  outstandingCheckDetail,
  outstandingMonths,
  invoiceLookup,
  profitability,
} from '../services/reports.js';
import {
  createZReport, updateZReport, deleteZReport, listZReports, missingZNumbers, getZReport,
  listExpenses, expensesTotal, deleteExpense, getExpense, EXPENSE_TYPES,
  replaceExpenses, setZReportImage, setManagerBreakdown,
  setDeposit, cashReconciliation, DENOMS,
  setCreditCards, ccReconciliation, CC_BRANDS,
  zReconciliationStatus,
} from '../services/zreports.js';
import { createDeposit, listDeposits, setDeposited, setDepositBag, deleteDeposit, depositTotalForZ, upsertDepositForZ, depositForZ, declaredNotDeposited, zReportsWithoutDeposit } from '../services/deposits.js';
import { listEmployees } from '../services/employees.js';
import { matchingClosing, CLOSING_DENOMS } from '../services/zclosing.js';
import { listInvoices } from '../services/invoices.js';
import { getExecutor } from '../db/adapter.js';
import { toAgorot, fromAgorot } from '../lib/money.js';
import { toCsv } from '../lib/csvExport.js';
import { handleInvoiceImage } from '../middleware/upload.js';
import { getObject, del as removeStored } from '../lib/storage.js';
import { notify } from '../lib/notify.js';
import { requirePageAccess, requirePermission } from '../middleware/requireOwner.js';
import { RuleError, AuthError, NotFoundError } from '../lib/errors.js';
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

// Parse the per-brand credit-card amounts from the Z form. Returns { amounts, total } (agorot).
function parseCc(b) {
  const amounts = {};
  let total = 0;
  for (const brand of CC_BRANDS) {
    const a = toAgorot(b[`cc_${brand.key}`] || '0');
    amounts[brand.key] = a;
    total += a;
  }
  return { amounts, total };
}

// Parse the itemized cash-expense rows (arrays) from the Z form into replaceExpenses() shape.
// Each row carries a kind (manual/salary/advance/invoice); the server normalizes the target
// field (employee for salary/advance, invoice for invoice) inside replaceExpenses.
function parseExpenseRows(b) {
  const dates = [].concat(b.expense_date || []);
  const names = [].concat(b.payer_name || []);
  const purposes = [].concat(b.purpose || []);
  const amounts = [].concat(b.amount || []);
  const invoiceIds = [].concat(b.expense_invoice_id || []);
  const kinds = [].concat(b.expense_kind || []);
  const employeeIds = [].concat(b.expense_employee_id || []);
  return amounts.map((a, i) => ({
    expenseDate: dates[i] || null,
    payerName: names[i],
    purpose: purposes[i],
    kind: kinds[i] || 'manual',
    employeeId: employeeIds[i] || null,
    amount: a != null && String(a).trim() !== '' ? toAgorot(a) : 0,
    invoiceId: invoiceIds[i] || null,
  }));
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

// WhatsApp status for a Z in the "רשומות Z אחרונות" list, per the owner's rule:
// depDiff = סכום ההפקדה − (סה"כ מגירה + הוצאות במזומן).
// 0 → תואם; deposit < base (depDiff<0) → חוסר; deposit > base (depDiff>0) → יתרה.
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
  // Bill reconciliation against the matching Z closing (same store + Z number).
  const closing = await matchingClosing(zr.store_id, zr.z_number);
  let closerBreakdown = null;
  if (closing) { try { closerBreakdown = JSON.parse(closing.breakdown || '{}'); } catch { closerBreakdown = {}; } }
  let managerBreakdown = {};
  if (zr.manager_breakdown) { try { managerBreakdown = JSON.parse(zr.manager_breakdown); } catch { managerBreakdown = {}; } }
  res.render('reports/zreport', {
    title: `עריכת דוח Z ${zr.z_number}`,
    zr,
    store,
    storeOptions: await storeList(),
    invoiceOptions: await invoicePickOptions(req.scope.companyIds),
    employeeOptions: await listEmployees(),
    ccBrands: CC_BRANDS,
    dep: await depositForZ(id),
    expenses: await listExpenses(id),
    closingDenoms: CLOSING_DENOMS,
    closing,
    closerBreakdown,
    managerBreakdown,
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
  // Accepts a full date (YYYY-MM-DD) or a month value (YYYY-MM, from a native <input type="month">).
  const fromRaw = q('from') || '';
  const anchor = /^\d{4}-\d{2}(-\d{2})?$/.test(fromRaw)
    ? new Date(`${fromRaw.length === 7 ? `${fromRaw}-01` : fromRaw}T00:00:00`)
    : now;
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
      // Reconciliation per the owner's rule: (סה"כ מגירה + הוצאות במזומן) מול סכום ההפקדה.
      const expenses = await expensesTotal(z.id);
      const dep = await depositForZ(z.id);
      const deposit = dep ? Number(dep.amount) || 0 : 0;
      const base = (z.drawer_total || 0) + expenses;
      const depDiff = deposit - base; // סכום הפקדה − (מגירה + הוצאות): <0 חוסר · >0 יתרה · 0 תואם
      const hasDeposit = !!dep;
      const depMatched = hasDeposit && depDiff === 0;
      const waText = zDepositWhatsappText(z, depDiff);
      return {
        ...z,
        expensesTotal: expenses,
        depositTotal: deposit,
        depositBag: dep ? dep.bag_number : null,
        hasDeposit,
        depDiff,
        depMatched,
        waText,
      };
    }),
  );
  res.render('reports/zreports', {
    title: 'דוחות Z',
    storeOptions: await storeList(),
    ccBrands: CC_BRANDS,
    zReports,
    unmatchedCount: zReports.filter((z) => z.hasDeposit && !z.depMatched).length,
    zStoreId,
    missingZ: zStoreId ? await missingZNumbers(zStoreId) : [],
    deposits: await listDeposits({ storeId: zStoreId, scope: req.scope.companyIds }),
    // Deposit-lifecycle rubrics (bottom of the page).
    zNoDeposit: await zReportsWithoutDeposit({ scope: req.scope.companyIds, storeId: zStoreId }),
    notDeposited: await declaredNotDeposited({ scope: req.scope.companyIds, storeId: zStoreId }),
    invoiceOptions: await invoicePickOptions(req.scope.companyIds),
    employeeOptions: await listEmployees(),
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

// Declare a deposit on a Z report that has none yet (from the "דוחות Z ללא הצהרת הפקדה" rubric).
// NOTE: path is /deposit-declare (not /deposits/declare) so the `router.use('/deposits/:id', …)`
// scope-guard above doesn't capture "declare" as an :id and 404 the request.
router.post('/deposit-declare', requirePermission('manage_deposits'), async (req, res, next) => {
  try {
    const zReportId = Number(req.body.z_report_id);
    const z = await getZReport(zReportId);
    if (!z) throw new NotFoundError('דוח Z לא נמצא');
    // Scope guard: the Z's store must belong to a company the user may access.
    if (req.scope.companyIds !== null) {
      const st = await getExecutor().one('SELECT company_id FROM stores WHERE id = ?', [z.store_id]);
      if (!st || !req.scope.companyIds.includes(Number(st.company_id))) throw new AuthError('אין הרשאה לדוח זה');
    }
    await createDeposit({
      storeId: z.store_id,
      zReportId,
      depositDate: z.z_date,
      bagNumber: req.body.bag_number || null,
      amount: toAgorot(req.body.amount || '0'),
      deposited: false,
    }, req.user);
    res.redirect(303, req.get('referer') || '/reports/zreports');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.redirect(303, '/reports/zreports?deperr=' + encodeURIComponent(err.message));
    }
    next(err);
  }
});

// Deposit declarations (הצהרה על הפקדה) — created together with a Z report (POST /zreports).
router.post('/deposits/:id/deposited', requirePermission('manage_deposits'), async (req, res, next) => {
  try {
    const markDeposited = req.body.value === '1';
    // Cancelling a deposit mark (un-marking) is owner-only — per the owner's request.
    if (!markDeposited && req.user.role !== 'owner') {
      throw new AuthError('ביטול סימון הפקדה — בעלים בלבד');
    }
    // The barcode scanner (or manual entry) can set the bag number as part of marking deposited.
    if (markDeposited && typeof req.body.bag_number === 'string' && req.body.bag_number.trim()) {
      await setDepositBag(Number(req.params.id), req.body.bag_number, req.user);
    }
    await setDeposited(Number(req.params.id), markDeposited, req.user);
    res.redirect(303, req.get('referer') || '/reports/zreports');
  } catch (err) {
    next(err);
  }
});

router.post('/deposits/:id/delete', requirePermission('manage_deposits'), async (req, res, next) => {
  try {
    await deleteDeposit(Number(req.params.id), req.user);
    res.redirect(303, req.get('referer') || '/reports/zreports');
  } catch (err) {
    next(err);
  }
});

// §7 "צ׳קים בחוץ"
// Parse the due-date cut from the query: mode 'all' | 'date' | 'months'. Returns the cut object for
// the services plus the raw selections for the view.
function parseOutstandingCut(q) {
  const cut = (q.cut === 'date' || q.cut === 'months') ? q.cut : 'all';
  const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(v || '') ? v : null);
  const from = cut === 'date' ? isoDate(q.from) : null;
  const to = cut === 'date' ? isoDate(q.to) : null;
  const months = cut === 'months'
    ? [].concat(q.months || []).filter((m) => /^\d{4}-\d{2}$/.test(m))
    : [];
  // Back-compat: a bare ?month= still works as a single-month cut.
  const month = (cut === 'all' && /^\d{4}-\d{2}$/.test(q.month || '')) ? q.month : null;
  return { cut, from, to, months, month };
}

router.get('/outstanding', requirePageAccess('nav_outstanding'), async (req, res, next) => {
  try {
    const c = parseOutstandingCut(req.query);
    const cutArg = { month: c.month, months: c.months, from: c.from, to: c.to };
    const { accounts, totalOutstanding } = await outstandingChecks(req.scope.companyIds, cutArg);
    const detailAccountId = req.query.account ? Number(req.query.account) : null;
    // Scope guard: only show detail for an account the user is allowed to see.
    const inScope = detailAccountId != null && accounts.some((a) => a.id === detailAccountId);
    res.render('reports/outstanding', {
      title: 'צ׳קים בחוץ',
      accounts,
      totalOutstanding,
      months: await outstandingMonths(req.scope.companyIds),
      month: c.month,
      cut: c.cut,
      selMonths: c.months,
      from: c.from,
      to: c.to,
      detailAccountId: inScope ? detailAccountId : null,
      detail: inScope ? await outstandingCheckDetail(detailAccountId, cutArg) : [],
    });
  } catch (err) {
    next(err);
  }
});

// Detailed per-store CSV — one row per open check with invoice/credit breakdown.
router.get('/outstanding-detail.csv', async (req, res, next) => {
  try {
    const accountId = Number(req.query.account);
    const c = parseOutstandingCut(req.query);
    const cutArg = { month: c.month, months: c.months, from: c.from, to: c.to };
    const { accounts } = await outstandingChecks(req.scope.companyIds);
    if (!accounts.some((a) => a.id === accountId)) { res.status(404).send('not found'); return; }
    const rows = (await outstandingCheckDetail(accountId, cutArg)).map((r) => [
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
    // Credit-card report must reconcile to "אשראי מגירה" before the Z can be added.
    const { amounts: ccAmounts, total: ccTotal } = parseCc(b);
    const drawerCredit = toAgorot(b.drawer_credit);
    if (ccTotal !== drawerCredit) throw new RuleError('VALIDATION', 'אין התאמה בהכנסות מאשראי');
    const created = await createZReport(
      {
        storeId,
        zNumber: b.z_number,
        zDate: b.z_date,
        dailyTotal: toAgorot(b.daily_total),
        drawerCash: toAgorot(b.drawer_cash),
        drawerCheck: toAgorot(b.drawer_check),
        drawerCredit,
        drawerHakafa: toAgorot(b.drawer_hakafa),
        drawerVouchers: toAgorot(b.drawer_vouchers),
      },
      req.user,
    );
    await setCreditCards(created.id, { amounts: ccAmounts }, req.user);
    // Optional cash-expense lines entered on the same form (itemized "הוצאות במזומן").
    {
      const rows = parseExpenseRows(b);
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

// Save edits to a Z (edit page). Same field set as the add form; credit-card total must equal
// "אשראי מגירה". Sends a push notification and stamps updated_at.
router.post('/zreports/:id', async (req, res, next) => {
  const id = Number(req.params.id);
  const b = req.body;
  try {
    const storeId = Number(b.store_id);
    const { amounts: ccAmounts, total: ccTotal } = parseCc(b);
    const drawerCredit = toAgorot(b.drawer_credit);
    if (ccTotal !== drawerCredit) throw new RuleError('VALIDATION', 'אין התאמה בהכנסות מאשראי');
    await updateZReport(
      id,
      {
        storeId,
        zNumber: b.z_number,
        zDate: b.z_date,
        dailyTotal: toAgorot(b.daily_total),
        drawerCash: toAgorot(b.drawer_cash),
        drawerCheck: toAgorot(b.drawer_check),
        drawerCredit,
        drawerHakafa: toAgorot(b.drawer_hakafa),
        drawerVouchers: toAgorot(b.drawer_vouchers),
      },
      req.user,
    );
    await setCreditCards(id, { amounts: ccAmounts }, req.user);
    await replaceExpenses(id, parseExpenseRows(b), req.user);
    await upsertDepositForZ(
      id,
      {
        storeId,
        depositDate: b.z_date,
        bagNumber: b.dep_bag,
        amount: toAgorot(b.dep_amount || '0'),
        deposited: b.dep_deposited === '1' || b.dep_deposited === 'on',
      },
      req.user,
    );
    // Push on edit (§ owner request), plus the cash-gap alert if one opened up.
    notify(`✏️ <b>עודכן דוח Z ${b.z_number}</b>\n${zUrl(req, id)}`);
    try {
      const cr = await cashReconciliation(id);
      if (cr.diff !== 0) {
        const label = cr.diff < 0 ? 'חוסר' : 'יתרה';
        notify(`⚠️ <b>פער מזומן ב-Z ${b.z_number}</b>\n${label} ע"ס ${ils(Math.abs(cr.diff))}\n${zUrl(req, id)}`);
      }
    } catch { /* best-effort */ }
    await renderZReport(req, res, id, { notice: 'הדוח עודכן.' });
  } catch (err) {
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

// Save the manager's bill recount vs the Z closing.
router.post('/zreports/:id/verify-bills', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const b = req.body;
    const data = {};
    for (const d of CLOSING_DENOMS) {
      const count = Math.max(0, Math.floor(Number(b[`mgr_count_${d.key}`]) || 0));
      const ok = b[`mgr_ok_${d.key}`] === '1' || b[`mgr_ok_${d.key}`] === 'on';
      if (count > 0 || ok) data[d.key] = { count, ok };
    }
    await setManagerBreakdown(id, data, req.user);
    await renderZReport(req, res, id, { notice: 'ספירת השטרות נשמרה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderZReport(req, res, id, { error: err.message });
    next(err);
  }
});

router.post('/zreports/:id/delete', requirePermission('delete_zreport'), async (req, res, next) => {
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

// "סכם" — replace ALL cash-expense lines at once from the collapsible table.
router.post('/zreports/:id/expenses-bulk', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    await replaceExpenses(id, parseExpenseRows(req.body), req.user);
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
