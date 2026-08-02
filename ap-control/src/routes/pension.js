import { Router } from 'express';
import {
  listEmployees,
  createEmployee,
  setPensionOpened,
  terminateEmployee,
  markReleaseSent,
  pensionAlerts,
  pensionSummary,
} from '../services/pension.js';
import { getExecutor } from '../db/adapter.js';
import { notify } from '../lib/notify.js';
import { config } from '../config.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

async function orgOptions() {
  const x = getExecutor();
  return {
    companies: await x.many('SELECT id, name FROM companies ORDER BY name', []),
    stores: await x.many('SELECT id, name, company_id FROM stores ORDER BY name', []),
  };
}

async function renderList(res, extra = {}) {
  res.render('pension/index', {
    title: 'מעקב פנסיה',
    employees: await listEmployees(extra.filter ? { status: extra.filter } : {}),
    alerts: await pensionAlerts(),
    summary: await pensionSummary(),
    filter: extra.filter || '',
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    const filter = ['active', 'terminated'].includes(req.query.status) ? req.query.status : null;
    await renderList(res, { filter, notice: req.query.pushed ? 'סיכום התראות נשלח בפוש.' : null });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    res.render('pension/new', { title: 'עובד חדש', ...(await orgOptions()), values: {}, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    await createEmployee(
      {
        name: req.body.name,
        companyId: req.body.company_id || null,
        storeId: req.body.store_id || null,
        startDate: req.body.start_date,
        priorPension: req.body.prior_pension === '1',
        notes: req.body.notes,
      },
      req.user,
    );
    res.redirect(303, '/pension');
  } catch (err) {
    if (err instanceof RuleError) {
      return res.status(400).render('pension/new', { title: 'עובד חדש', ...(await orgOptions()), values: req.body, error: err.message });
    }
    next(err);
  }
});

router.post('/:id/open', async (req, res, next) => {
  try {
    await setPensionOpened(Number(req.params.id), req.body.date || null, req.user);
    res.redirect(303, '/pension');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

router.post('/:id/terminate', async (req, res, next) => {
  try {
    await terminateEmployee(Number(req.params.id), { date: req.body.date || null, reason: req.body.reason }, req.user);
    res.redirect(303, '/pension');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

router.post('/:id/release', async (req, res, next) => {
  try {
    await markReleaseSent(Number(req.params.id), req.body.date || null, req.user);
    res.redirect(303, '/pension');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

// Push a summary of current pension breaches to the owner. Works from the in-app button (session)
// or an external scheduler (?key=CRON_SECRET, no session) — same pattern as the reminders runner.
router.all('/alerts/run', async (req, res, next) => {
  try {
    const keyOk = config.cronSecret && req.query.key === config.cronSecret;
    if (!keyOk && !req.user) return res.status(401).json({ error: 'unauthorized' });
    const alerts = await pensionAlerts();
    if (alerts.length) {
      const lines = alerts.map((e) => `• ${e.name} (${e.company_name || '—'}): ${e.risk.label}`);
      notify(`⚖️ <b>פנסיה — התראות ציות</b>\n${lines.join('\n')}`);
    }
    if (req.user && req.method === 'POST') return res.redirect(303, '/pension?pushed=1');
    return res.json({ alerts: alerts.length });
  } catch (err) {
    next(err);
  }
});

export default router;
