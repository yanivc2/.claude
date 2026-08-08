import { Router } from 'express';
import { createZClosing, listZClosings, CLOSING_DENOMS, israelNow } from '../services/zclosing.js';
import { getExecutor } from '../db/adapter.js';
import { scopeClause } from '../lib/scope.js';
import { toAgorot } from '../lib/money.js';
import { RuleError } from '../lib/errors.js';

const router = Router();

// Stores the closer may pick — limited to the companies granted to them (owner sees all).
async function storeOptionsFor(req) {
  const sc = scopeClause(req.scope?.companyIds ?? null, 'c.id');
  return getExecutor().many(
    `SELECT st.id, st.name, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id
      WHERE 1 = 1${sc.sql} ORDER BY c.name, st.name`,
    [...sc.params],
  );
}

async function render(req, res, extra = {}) {
  res.render('zclosing/index', {
    title: 'סגירת Z',
    denoms: CLOSING_DENOMS,
    storeOptions: await storeOptionsFor(req),
    startedAt: israelNow(),
    closings: await listZClosings({ limit: 30 }),
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await render(req, res);
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const b = req.body;
  try {
    const counts = {};
    for (const d of CLOSING_DENOMS) counts[d.key] = Number(b[`count_${d.key}`] || 0);
    const descs = [].concat(b.exp_desc || []);
    const amounts = [].concat(b.exp_amount || []);
    const expenses = descs.map((desc, i) => ({
      desc,
      amount: amounts[i] != null && String(amounts[i]).trim() !== '' ? toAgorot(amounts[i]) : 0,
    }));
    await createZClosing(
      {
        employeeFirst: b.employee_first,
        employeeLast: b.employee_last,
        storeId: b.store_id || null,
        zNumber: b.z_number,
        drawerCash: toAgorot(b.drawer_cash || '0'),
        startedAt: b.started_at,
        counts,
        expenses,
      },
      req.user,
    );
    await render(req, res, { notice: 'הסגירה נשמרה. תודה!' });
  } catch (err) {
    if (err instanceof RuleError) return render(req, res, { error: err.message });
    next(err);
  }
});

export default router;
