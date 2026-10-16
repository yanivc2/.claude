import { Router } from 'express';
import { cashPanelExtras } from '../services/cashPanel.js';
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
import { listNotifications, unscopedNotificationCount } from '../services/notifications.js';

// שני סוגי ההתראה שהבעלים ביקש לראות בלוח עצמו ולא רק בפעמון.
// מה שכרטיס "התראות מזומן" בלוח מציג: רק מה שדורש תשומת לב — צ׳ק שכר שנפרע בבנק לפני שהותאם (אותו שכר
// עלול לצאת פעמיים). התאמה שבוצעה (`cash_match`) כבר נסגרה — בעלים, 16/10: "אם זה הותאם אין טעם להציג
// אותו"; היא נשארת בפעמון ובטלגרם.
const CASH_ALERT_KINDS = ['salary_cleared_unmatched'];
import { listDeposits, zReportsWithoutDeposit, declaredNotDeposited, depositVerifications, depositZDiffs } from '../services/deposits.js';
import { voidedChecksSeenInBank } from '../services/reconciliation.js';
import { searchSuppliers, listSuppliers } from '../services/suppliers.js';
import { listRecent } from '../services/audit.js';
import { createEvent, listEventsInRange, deleteEvent, runDueReminders } from '../services/calendar.js';
import { listRequests, approveRequest, rejectRequest, actionLabel } from '../services/changeRequests.js';
import { getExecutor } from '../db/adapter.js';
import { effectiveStoreId } from '../lib/scope.js';
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
    // בדיקת חשבונית: שני שדות — מספר (`q`: חשבונית / צ׳ק / הקצאה / אסמכתה) ושם (`name`: ספק).
    const q = (req.query.q || '').trim();
    const name = (req.query.name || '').trim();
    const unpaidOnly = req.query.unpaid === '1';
    // 🔒 רק החנות הפעילה (בעלים, 16/10: "בטל את האפשרות לבחור חנות או חברה") — אין יותר ?store= /
    // ?company= / ?oc_store= בלוח. בלי חנות פעילה ("כל החנויות") — כל מה שבתחום ההרשאה.
    const storeId = effectiveStoreId(req, null);
    const scope = req.scope; // {companyIds, storeIds} — scopeClause tolerates it; scopeWhere adds the store filter
    const x = getExecutor();

    // "צ׳קים בחוץ" — החנות הפעילה, או כל החנויות. (היה כאן בורר חנות משלו — בוטל.)
    const { accounts: ocAccounts, totalOutstanding } = await outstandingChecks(scope);
    const ocSelected = storeId ? ocAccounts.find((a) => a.store_id === storeId) : null;
    const outstandingDisplay = storeId ? (ocSelected ? ocSelected.outstanding : 0) : totalOutstanding;
    const openChecksCount = storeId
      ? Number(ocSelected?.outstanding_count) || 0
      : ocAccounts.reduce((s, a) => s + (Number(a.outstanding_count) || 0), 0);

    // תוצאות: מספר → חשבוניות לפי מספר/הקצאה + תשלומים; שם → חשבוניות לפי ספק + ספקים.
    let invoiceResults = null;
    if (q || name) {
      const seen = new Set();
      invoiceResults = [];
      for (const [term, by] of [[q, 'number'], [name, 'name']]) {
        if (!term) continue;
        for (const r of await invoiceLookup(term, { storeId, scope, unpaidOnly, by })) {
          const k = `${r.id}|${r.check_number || ''}`;
          if (!seen.has(k)) { seen.add(k); invoiceResults.push(r); }
        }
      }
    }

    const depositRows = await listDeposits({ scope, storeId, limit: 20 });
    res.render('dashboard', {
      title: 'לוח בקרה',
      stats: await dashboardStats(scope, storeId),
      q,
      name,
      storeId,
      quickMenu: true,
      ocSelectedName: ocSelected ? ocSelected.store_name : null,
      outstandingDisplay,
      unpaidOnly,
      invoiceResults,
      checkResults: q ? await lookupChecks(q, scope) : null,
      supplierResults: name ? await searchSuppliers(name, req.scope) : null,
      unmatchedCash: await withMatchCandidates(await unmatchedCashExpenses(scope, 20, storeId), scope, storeId),
      // "הותאם ל" + אנשי קשר לוואטסאפ — services/cashPanel.js (מקור אחד לשני הדפים).
      ...(await cashPanelExtras(scope, storeId)),
      cashSettleReady: await cashSettleReady(),
      // 🔴 ההתראות על תנועות מזומן מוצגות **בלוח הבקרה עצמו**, לא רק בפעמון: אלה בדיוק
      // האירועים שהבעלים ביקש לראות (התאמת מזומן, וצ׳ק שכר שנפרע לפני התאמה), והפעמון נקרא
      // רק כשנכנסים אליו. owner-only, כמו כל ההתראות.
      // 🔴 מסונן לחנות הפעילה. ההתראה נושאת `store_id` מרגע שנרשמה, ולכן התראה על מזומן של
      // סניף אחד אינה מוצגת תחת סניף אחר. התראות ישנות (לפני העמודה) נספרות בנפרד ומוצגות
      // בתצוגת "כל החנויות" — הן אינן נעלמות, הן פשוט לא נתלות על חנות שאולי אינה שלהן.
      // …ורק כל עוד לא נקראה: "✓ ראיתי" בשורה מסמן אותה כנקראה והיא יוצאת מהלוח (נשארת ב-/notifications).
      cashAlerts: req.user?.role === 'owner'
        ? await listNotifications({ limit: 8, storeId, kinds: CASH_ALERT_KINDS, unreadOnly: true })
        : [],
      cashAlertsUnscoped: req.user?.role === 'owner' && storeId
        ? await unscopedNotificationCount(CASH_ALERT_KINDS)
        : 0,
      settledCash: await settledCashExpenses(scope, 30, storeId),
      cashErr: req.query.cashErr ? String(req.query.cashErr) : null,
      depositsHistory: depositRows,
      // אותה טבלה של המרקורים, ולכן אותם נתונים בדיוק (partials/_deposits.ejs).
      depVerify: await depositVerifications(depositRows),
      depZDiff: await depositZDiffs(depositRows),
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
    // `invoice_ids` = "12,15" (כמה חשבוניות, גם של ספקים שונים); `invoice_id` — טופס ישן.
    await matchCashExpenseToInvoice(
      req.params.source, Number(req.params.id), req.body.invoice_ids || req.body.invoice_id, req.user, req.scope,
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
  // חזרה לדף שממנו נלחץ (לוח / מרקורים / חשבוניות) — רק נתיב פנימי.
  const back = (String(req.body.return_to || '/').startsWith('/') && !String(req.body.return_to).startsWith('//')) ? String(req.body.return_to) : '/';
  const withParam = (k, v) => `${back}${back.includes('?') ? '&' : '?'}${k}=${encodeURIComponent(v)}`;
  try {
    const r = await setCashExpenseSettled(req.params.source, Number(req.params.id), req.body.undo !== '1', req.user, req.scope);
    // המזכירה: בוצע, ננעל, ונשלח לאישור הבעלים — הדף אומר את זה.
    return res.redirect(303, r?.pendingApproval ? withParam('cashNote', 'סומן כטופל ונשלח לאישור הבעלים. עד האישור רק הבעלים יכול לבטל.') : back);
  } catch (err) {
    if (err instanceof RuleError || err instanceof NotFoundError) {
      return res.redirect(303, withParam('cashErr', err.message));
    }
    next(err);
  }
});

// "אשר / דחה" נלחצים גם מדף ההתראות — חוזרים לשם (נתיב פנימי בלבד).
const approvalsBack = (req) => {
  const b = String(req.body?.return_to || '');
  return b.startsWith('/') && !b.startsWith('//') ? b : '/approvals';
};

router.post('/approvals/:id/approve', ownerOnly, async (req, res, next) => {
  try {
    await approveRequest(Number(req.params.id), req.user);
    res.redirect(303, approvalsBack(req));
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
    res.redirect(303, approvalsBack(req));
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
