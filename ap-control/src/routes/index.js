import { Router } from 'express';
import {
  dashboardStats,
  invoiceLookup,
  latestBalances,
  outstandingChecksInRange,
} from '../services/reports.js';
import { lookupChecks } from '../services/payments.js';
import { searchSuppliers } from '../services/suppliers.js';
import { listRecent } from '../services/audit.js';
import { getExecutor } from '../db/adapter.js';

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function parseAnchor(s) {
  const d = s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const companyId = req.query.company ? Number(req.query.company) : null;
    const storeId = req.query.store ? Number(req.query.store) : null;
    const x = getExecutor();
    res.render('dashboard', {
      title: 'לוח בקרה',
      stats: await dashboardStats(),
      q,
      companyId,
      storeId,
      companies: await x.many('SELECT id, name FROM companies ORDER BY name', []),
      stores: await x.many('SELECT id, name, company_id FROM stores ORDER BY name', []),
      invoiceResults: q ? await invoiceLookup(q, { companyId, storeId }) : null,
      checkResults: q ? await lookupChecks(q) : null,
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
router.get('/audit', async (req, res, next) => {
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

    const checks = await outstandingChecksInRange(ymd(gridStart), ymd(gridEnd));
    const byDate = {};
    for (const c of checks) {
      (byDate[c.payment_date] ||= { count: 0, total: 0 });
      byDate[c.payment_date].count += 1;
      byDate[c.payment_date].total += c.amount;
    }

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
      balances: await latestBalances(),
      rangeCount: checks.length,
      rangeTotal: checks.reduce((s, c) => s + c.amount, 0),
      entries: await listRecent(200),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
