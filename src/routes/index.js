import { Router } from 'express';
import {
  dashboardStats,
  invoiceLookup,
  latestBalances,
  outstandingChecks,
  outstandingChecksInRange,
} from '../services/reports.js';
import { lookupChecks } from '../services/payments.js';
import {
  unmatchedCashExpenses, zSequenceStatus, setCashExpenseSettled, cashSettleReady, settledCashExpenses,
  matchCashExpenseToInvoice, assertCashExpenseInScope, withMatchCandidates,
} from '../services/zreports.js';
import { markCashed } from '../services/salaryPayments.js';
import { listNotifications } from '../services/notifications.js';
import { listDeposits, zReportsWithoutDeposit, declaredNotDeposited } from '../services/deposits.js';
import { voidedChecksSeenInBank } from '../services/reconciliation.js';
import { searchSuppliers, listSuppliers } from '../services/suppliers.js';
import { listRecent } from '../services/audit.js';
import { createEvent, listEventsInRange, deleteEvent, runDueReminders } from '../services/calendar.js';
import { listRequests, approveRequest, rejectRequest, actionLabel } from '../services/changeRequests.js';
import { getExecutor } from '../db/adapter.js';
import { scopeClause, scopedStoreList, effectiveStoreId } from '../lib/scope.js';
import { config } from '../config.js';
import { requirePageAccess } from '../middleware/requireOwner.js';
import { AuthError, RuleError, NotFoundError } from '../lib/errors.js';

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseAnchor(s) {
  const d = s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const router = Router();

router.get('/', requirePageAccess('nav_dashboard'), async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const unpaidOnly = req.query.unpaid === '1';
    let companyId = req.query.company ? Number(req.query.company) : null;
    // Default the dashboard to the active-store context unless an explicit ?store= is given.
    let storeId = effectiveStoreId(req, req.query.store);
    const scope = req.scope; // {companyIds, storeIds} — scopeClause tolerates it; scopeWhere adds the store filter
    const cScope = scopeClause(scope, 'id');
    const x = getExecutor();
    const companies = await x.many(`SELECT id, name FROM companies WHERE 1 = 1${cScope.sql} ORDER BY name`, [...cScope.params]);
    // Company scope alone used to list every store of a granted company here — including ones the
    // user holds no per-store grant for. scopedStoreList filters on both dimensions.
    const stores = (await scopedStoreList(scope, x)).map((s) => ({ id: Number(s.id), name: s.name, company_id: Number(s.company_id) }));
    // A forged ?store= must not become a filter for a store we cannot see: drop it if unknown.
    if (storeId && !stores.some((st) => st.id === storeId)) storeId = null;

    // בחירת חנות משייכת אותה מיד לחברה שלה. בחירת חברה בלבד: אם יש חנות אחת בחברה
    // היא נבחרת אוטומטית; אם יש שתיים או יותר, מחפשים בכל חנויות החברה (storeId נשאר ריק).
    if (storeId) {
      const s = stores.find((st) => st.id === storeId);
      if (s) companyId = s.company_id;
    } else if (companyId) {
      const inCompany = stores.filter((st) => st.company_id === companyId);
      if (inCompany.length === 1) storeId = inCompany[0].id;
    }

    // "צ׳קים בחוץ" tile — pick a store (oc_store) to see just its outstanding total,
    // otherwise all stores combined. Reuses the per-account outstanding breakdown.
    // Default the outstanding tile to the active-store context (unless an explicit oc_store is given).
    const ocStore = req.query.oc_store ? Number(req.query.oc_store) : (storeId || null);
    const { accounts: ocAccounts, totalOutstanding } = await outstandingChecks(scope);
    const ocSelected = ocStore ? ocAccounts.find((a) => a.store_id === ocStore) : null;
    const outstandingDisplay = ocSelected ? ocSelected.outstanding : totalOutstanding;
    const ocBase = new URLSearchParams();
    if (q) ocBase.set('q', q);
    if (req.query.company) ocBase.set('company', String(req.query.company));
    if (req.query.store) ocBase.set('store', String(req.query.store));
    const ocLinkBase = ocBase.toString();

    // "צ׳קים פתוחים" tile — the number of outstanding (issued, not-yet-cleared) checks,
    // matching the "צ׳קים בחוץ" money tile's store selection.
    const openChecksCount = ocSelected
      ? Number(ocSelected.outstanding_count) || 0
      : ocAccounts.reduce((s, a) => s + (Number(a.outstanding_count) || 0), 0);

    res.render('dashboard', {
      title: 'לוח בקרה',
      stats: await dashboardStats(scope, storeId),
      q,
      companyId,
      storeId,
      ocAccounts,
      ocStore,
      ocSelectedName: ocSelected ? ocSelected.store_name : null,
      outstandingDisplay,
      ocLinkBase,
      companies,
      stores,
      unpaidOnly,
      invoiceResults: q ? await invoiceLookup(q, { companyId, storeId, scope, unpaidOnly }) : null,
      checkResults: q ? await lookupChecks(q, scope) : null,
      supplierResults: q ? await searchSuppliers(q, req.scope) : null,
      unmatchedCash: await withMatchCandidates(await unmatchedCashExpenses(scope, 20, storeId), scope, storeId),
      cashSettleReady: await cashSettleReady(),
      // 🔴 ההתראות על תנועות מזומן מוצגות **בלוח הבקרה עצמו**, לא רק בפעמון: אלה בדיוק
      // האירועים שהבעלים ביקש לראות (התאמת מזומן, וצ׳ק שכר שנפרע לפני התאמה), והפעמון נקרא
      // רק כשנכנסים אליו. owner-only, כמו כל ההתראות.
      cashAlerts: req.user?.role === 'owner'
        ? (await listNotifications({ limit: 40 }))
            .filter((n) => n.kind === 'cash_match' || n.kind === 'salary_cleared_unmatched')
            .slice(0, 8)
        : [],
      settledCash: await settledCashExpenses(scope, 30, storeId),
      cashErr: req.query.cashErr ? String(req.query.cashErr) : null,
      depositsHistory: await listDeposits({ scope, storeId, limit: 20 }),
      zStatus: await zSequenceStatus(scope, storeId),
      zNoDepositCount: (await zReportsWithoutDeposit({ scope, storeId })).length,
      notDepositedCount: (await declaredNotDeposited({ scope, storeId })).length,
      openChecksCount,
      voidedInBank: await voidedChecksSeenInBank(scope, storeId),
      // An outgoing transfer the bank reported with no request behind it (services/transfers.js).
      // Tolerant: the table arrives with a schema upgrade the owner runs by hand.
      untrackedTransfers: await (async () => {
        try {
          const { untrackedTransfers } = await import('../services/transfers.js');
          return await untrackedTransfers({ scope });
        } catch { return []; }
      })(),
    });
  } catch (err) {
    next(err);
  }
});

// Defensive: a stray POST to / (e.g. a proxy preserving method on a redirect) -> dashboard.
router.post('/', (req, res) => res.redirect(303, '/'));

// "יומן" — a calendar of outstanding checks (when they will hit the account), account balance
// on top (only if we have one), and the full audit log collapsed at the bottom.
// ---- Approvals (owner only) ----
function ownerOnly(req, res, next) {
  if (req.user?.role !== 'owner') return next(new AuthError('אישור/דחיית שינויים — בעלים בלבד'));
  next();
}

router.get('/approvals', ownerOnly, async (req, res, next) => {
  try {
    res.render('approvals', {
      title: 'אישורים',
      pending: await listRequests({ status: 'pending' }),
      pendingSuppliers: await listSuppliers('pending'),
      history: await listRequests({ status: null }),
      actionLabel,
      notice: null,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// התאמת הוצאת מזומן לחשבונית — הכפתור של כל שורה שאינה פריטה ואינה שכר. "כל סכום יקבל
// חשבונית", ולכן זו דרך היציאה הרגילה מהרשימה.
router.post('/cash-expenses/:source/:id/match-invoice', async (req, res, next) => {
  try {
    await matchCashExpenseToInvoice(
      req.params.source, Number(req.params.id), Number(req.body.invoice_id), req.user, req.scope,
    );
    return res.redirect(303, '/');
  } catch (err) {
    if (err instanceof RuleError || err instanceof NotFoundError) {
      return res.redirect(303, '/?cashErr=' + encodeURIComponent(err.message));
    }
    next(err);
  }
});

// התאמת הוצאת שכר לצ׳ק שהוזן בדף עובדים ומשכורות. `markCashed` מבטל את הצ׳ק, אחרת הוא ייפרע
// בבנק ואותו שכר ישולם פעמיים (services/salaryPayments.js).
router.post('/cash-expenses/:source/:id/match-salary', async (req, res, next) => {
  try {
    // הסקופ נבדק על צד ההוצאה לפני הפעולה — אותה בדיקה כמו בכל כתיבה אחרת.
    await assertCashExpenseInScope(req.params.source, Number(req.params.id), req.scope);
    await markCashed(
      Number(req.body.salary_payment_id), Number(req.params.id), req.user, undefined,
      { source: req.params.source },
    );
    return res.redirect(303, '/');
  } catch (err) {
    if (err instanceof RuleError || err instanceof NotFoundError || err?.name === 'RuleError') {
      return res.redirect(303, '/?cashErr=' + encodeURIComponent(err.message));
    }
    next(err);
  }
});

// סימון הוצאת מזומן כ"טופלה" — דרך היציאה של פריטה שנאספה חזרה לקופה. אין לה חשבונית ואין לה
// קישור אוטומטי, ובלי הסימון הזה היא נשארת ב"תשלום במזומן ללא התאמה" לנצח.
// PRG: כל POST מסתיים ב-303 חזרה ללוח הבקרה (ראה CLAUDE.md).
router.post('/cash-expenses/:source/:id/settle', async (req, res, next) => {
  try {
    await setCashExpenseSettled(req.params.source, Number(req.params.id), req.body.undo !== '1', req.user, req.scope);
    return res.redirect(303, req.body.return_to || '/');
  } catch (err) {
    if (err instanceof RuleError || err instanceof NotFoundError) {
      return res.redirect(303, '/?cashErr=' + encodeURIComponent(err.message));
    }
    next(err);
  }
});

router.post('/approvals/:id/approve', ownerOnly, async (req, res, next) => {
  try {
    await approveRequest(Number(req.params.id), req.user);
    res.redirect(303, '/approvals');
  } catch (err) {
    if (err instanceof AuthError || err?.name === 'RuleError') {
      return res.render('approvals', {
        title: 'אישורים',
        pending: await listRequests({ status: 'pending' }),
        pendingSuppliers: await listSuppliers('pending'),
        history: await listRequests({ status: null }),
        actionLabel,
        notice: null,
        error: err.message,
      });
    }
    next(err);
  }
});

router.post('/approvals/:id/reject', ownerOnly, async (req, res, next) => {
  try {
    await rejectRequest(Number(req.params.id), req.user, req.body.note || null);
    res.redirect(303, '/approvals');
  } catch (err) {
    next(err);
  }
});

router.get('/audit', requirePageAccess('nav_audit'), async (req, res, next) => {
  try {
    const view = req.query.view === 'week' ? 'week' : 'month';
    const anchor = parseAnchor(req.query.anchor);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let gridStart;
    let weeksCount;
    let prevAnchor;
    let nextAnchor;
    if (view === 'week') {
      gridStart = new Date(anchor);
      gridStart.setDate(anchor.getDate() - anchor.getDay()); // back to Sunday
      weeksCount = 1;
      const p = new Date(gridStart); p.setDate(p.getDate() - 7); prevAnchor = ymd(p);
      const n = new Date(gridStart); n.setDate(n.getDate() + 7); nextAnchor = ymd(n);
    } else {
      const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      gridStart = new Date(first);
      gridStart.setDate(first.getDate() - first.getDay());
      weeksCount = 6;
      prevAnchor = ymd(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
      nextAnchor = ymd(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
    }
    const gridEnd = new Date(gridStart);
    gridEnd.setDate(gridStart.getDate() + weeksCount * 7 - 1);

    const checks = await outstandingChecksInRange(ymd(gridStart), ymd(gridEnd), req.scope);
    const byDate = {};
    for (const c of checks) {
      (byDate[c.payment_date] ||= { count: 0, total: 0 });
      byDate[c.payment_date].count += 1;
      byDate[c.payment_date].total += c.amount;
    }

    const events = await listEventsInRange(ymd(gridStart), ymd(gridEnd));
    const eventsByDate = {};
    for (const e of events) (eventsByDate[e.event_date] ||= []).push(e);

    const weeks = [];
    for (let w = 0; w < weeksCount; w += 1) {
      const days = [];
      for (let d = 0; d < 7; d += 1) {
        const cur = new Date(gridStart);
        cur.setDate(gridStart.getDate() + w * 7 + d);
        const iso = ymd(cur);
        const agg = byDate[iso];
        days.push({
          iso,
          day: cur.getDate(),
          inMonth: view === 'week' ? true : cur.getMonth() === anchor.getMonth(),
          isToday: iso === ymd(today),
          count: agg ? agg.count : 0,
          total: agg ? agg.total : 0,
          events: eventsByDate[iso] || [],
        });
      }
      weeks.push(days);
    }

    res.render('audit', {
      title: 'יומן',
      view,
      anchor: ymd(anchor),
      prevAnchor,
      nextAnchor,
      todayAnchor: ymd(today),
      periodLabel: anchor.toLocaleDateString('he-IL', { month: 'long', year: 'numeric' }),
      weeks,
      balances: await latestBalances(req.scope),
      rangeCount: checks.length,
      rangeTotal: checks.reduce((s, c) => s + c.amount, 0),
      events,
      remindersEnabled: config.telegram.enabled,
      entries: await listRecent(200, req.scope),
    });
  } catch (err) {
    next(err);
  }
});

// Create a calendar event / reminder, then return to the same calendar view.
router.post('/audit/events', async (req, res, next) => {
  try {
    await createEvent(
      { title: req.body.title, eventDate: req.body.event_date, eventTime: req.body.event_time, remind: req.body.remind === '1' },
      req.user,
    );
    const q = new URLSearchParams({ view: req.body.view || 'month', anchor: req.body.anchor || '' }).toString();
    res.redirect(303, `/audit?${q}`);
  } catch (err) {
    next(err);
  }
});

router.post('/audit/events/:id/delete', async (req, res, next) => {
  try {
    await deleteEvent(Number(req.params.id), req.user);
    const q = new URLSearchParams({ view: req.body.view || 'month', anchor: req.body.anchor || '' }).toString();
    res.redirect(303, `/audit?${q}`);
  } catch (err) {
    next(err);
  }
});

// Reminders runner — for a cron ping (?key=CRON_SECRET, no session) or the manual button (owner).
router.all('/audit/reminders/run', async (req, res, next) => {
  try {
    const keyOk = config.cronSecret && req.query.key === config.cronSecret;
    if (!keyOk && !req.user) return res.status(401).json({ error: 'unauthorized' });
    const r = await runDueReminders();
    if (req.user && req.method === 'POST') {
      return res.redirect(303, `/audit?view=${req.body.view || 'month'}&anchor=${req.body.anchor || ''}`);
    }
    return res.json(r);
  } catch (err) {
    next(err);
  }
});

export default router;
