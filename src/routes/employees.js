import { Router } from 'express';
import {
  listEmployees, createEmployee, deleteEmployee, listEmployeeLedger, employeeTotals,
} from '../services/employees.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

async function render(req, res, extra = {}) {
  res.render('employees/index', {
    title: 'עובדים ומשכורות',
    totals: await employeeTotals(),
    ledger: await listEmployeeLedger(),
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
  try {
    await createEmployee({ firstName: req.body.first_name, lastName: req.body.last_name }, req.user);
    await render(req, res, { notice: 'העובד נוסף.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const r = await deleteEmployee(Number(req.params.id), req.user);
    await render(req, res, { notice: r.deactivated ? 'העובד הועבר ללא-פעיל (יש לו רישומים).' : 'העובד נמחק.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

export default router;
