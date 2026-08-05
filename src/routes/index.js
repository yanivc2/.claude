import { Router } from 'express';
import {
  dashboardStats,
  invoiceLookup,
  latestBalances,
  outstandingChecks,
  outstandingChecksInRange,
} from '../services/reports.js';
import { lookupChecks } from '../services/payments.js';
import { searchSuppliers } from '../services/suppliers.js';
import { listRecent } from '../services/audit.js';
import { createEvent, listEventsInRange, deleteEvent, runDueReminders } from '../services/calendar.js';
import { listRequests, approveRequest, rejectRequest, actionLabel } from '../services/changeRequests.js';
import { getExecutor } from '../db/adapter.js';
import { scopeClause } from '../lib/scope.js';
import { config } from '../config.js';
import { requirePageAccess } from '../middleware/requireOwner.js';
import { AuthError } from '../lib/errors.js';

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
    let companyId = req.query.company ? Number(req.query.company) : null;
    let storeId = req.query.store ? Number(req.query.store) : null;
    const scope = req.scope.companyIds; // null = all (owner)
    const cScope = scopeClause(scope, 'id');
    const sScope = scopeClause(scope, 'company_id');
    const x = getExecutor();
    const companies = await x.many(`SELECT id, name FROM companies WHERE 1 = 1${cScope.sql} ORDER BY name`, [...cScope.params]);
    const stores = await x.many(`SELECT id, name, company_id FROM stores WHERE 1 = 1${sScope.sql} ORDER BY name`, [...sScope.params]);

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
    const ocStore = req.query.oc_store ? Number(req.query.oc_store) : null;
    const { accounts: ocAccounts, totalOutstanding } = await outstandingChecks(scope);
    const ocSelected = ocStore ? ocAccounts.find((a) => a.store_id === ocStore) : null;
    const outstandingDisplay = ocSelected ? ocSelected.outstanding : totalOutstanding;
    const ocBase = new URLSearchParams();
    if (q) ocBase.set('q', q);
    if (req.query.company) ocBase.set('company', String(req.query.company));
    if (req.query.store) ocBase.set('store', String(req.query.store));
    const ocLinkBase = ocBase.toString();

    res.render('dashboard', {
      title: 'לוח בקרה',
      stats: await dashboardStats(scope),
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
      invoiceResults: q ? await invoiceLookup(q, { companyId, storeId, scope }) : null,
      checkResults: q ? await lookupChecks(q, scope) : null,
      supplierResults: q ? await searchSuppliers(q) : null,
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
      history: await listRequests({ status: null }),
      actionLabel,
      notice: null,
      error: null,
    });
  } catch (err) {
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

    const checks = await outstandingChecksInRange(ymd(gridStart), ymd(gridEnd), req.scope.companyIds);
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
      balances: await latestBalances(req.scope.companyIds),
      rangeCount: checks.length,
      rangeTotal: checks.reduce((s, c) => s + c.amount, 0),
      events,
      remindersEnabled: config.telegram.enabled,
      entries: await listRecent(200),
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
