import { Router } from 'express';
import { createZClosing, listZClosings, CLOSING_DENOMS, israelNow } from '../services/zclosing.js';
import { toAgorot } from '../lib/money.js';
import { RuleError } from '../lib/errors.js';

const router = Router();

async function render(req, res, extra = {}) {
  res.render('zclosing/index', {
    title: 'סגירת Z',
    denoms: CLOSING_DENOMS,
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
