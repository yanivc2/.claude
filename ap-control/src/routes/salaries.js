import { Router } from 'express';
import { listSalaries, createSalary, deleteSalary, salariesTotal } from '../services/salaries.js';
import { getExecutor } from '../db/adapter.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

async function bankAccounts() {
  return getExecutor().many(
    `SELECT ba.id, ba.display_name FROM bank_accounts ba
       JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
      ORDER BY c.name, st.name`,
    [],
  );
}

function filters(req) {
  return {
    from: req.query.from || null,
    to: req.query.to || null,
    employee: req.query.employee || null,
  };
}

async function renderList(res, extra = {}) {
  const f = extra.filters || { from: null, to: null, employee: null };
  res.render('salaries/index', {
    title: 'משכורות',
    salaries: await listSalaries(f),
    summary: await salariesTotal(f),
    accounts: await bankAccounts(),
    filters: f,
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    const f = filters(req);
    await renderList(res, { filters: f, notice: req.query.created ? 'רישום השכר נשמר.' : null });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    res.render('salaries/new', { title: 'רישום שכר', accounts: await bankAccounts(), values: {}, error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    await createSalary(
      {
        employeeName: req.body.employee_name,
        bankAccountId: req.body.bank_account_id || null,
        method: req.body.method,
        reference: req.body.reference,
        amount: req.body.amount,
        payDate: req.body.pay_date,
        period: req.body.period,
        notes: req.body.notes,
      },
      req.user,
    );
    res.redirect(303, '/salaries?created=1');
  } catch (err) {
    if (err instanceof RuleError) {
      return res.status(400).render('salaries/new', {
        title: 'רישום שכר',
        accounts: await bankAccounts(),
        values: req.body,
        error: err.message,
      });
    }
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await deleteSalary(Number(req.params.id), req.user);
    res.redirect(303, '/salaries');
  } catch (err) {
    if (err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

export default router;
