import { Router } from 'express';
import {
  createPayment,
  markCleared,
  voidPayment,
  getPaymentDetail,
  getCheckPrintData,
  listPayments,
} from '../services/payments.js';
import { listPayable } from '../services/invoices.js';
import { getDb } from '../db/index.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

router.get('/', (req, res) => {
  const companyId = req.query.company ? Number(req.query.company) : null;
  const storeId = req.query.store ? Number(req.query.store) : null;
  const db = getDb();
  res.render('payments/index', {
    title: 'תשלומים (צ׳קים)',
    payments: listPayments({ status: req.query.status || null, companyId, storeId }),
    filter: req.query.status || '',
    companyId,
    storeId,
    companies: db.prepare('SELECT id, name FROM companies ORDER BY name').all(),
    stores: db.prepare('SELECT id, name, company_id FROM stores ORDER BY name').all(),
  });
});

router.get('/new', (req, res) => {
  res.render('payments/new', {
    title: 'צ׳ק חדש',
    payable: listPayable(),
    accounts: getDb().prepare('SELECT * FROM bank_accounts ORDER BY display_name').all(),
    values: {},
    error: null,
  });
});

router.post('/', (req, res, next) => {
  const b = req.body;
  const invoiceIds = []
    .concat(b.invoice_ids || [])
    .map(Number)
    .filter(Boolean);
  try {
    const payment = createPayment(
      {
        bankAccountId: Number(b.bank_account_id),
        checkNumber: b.check_number,
        paymentDate: b.payment_date,
        invoiceIds,
      },
      req.user,
    );
    res.redirect(`/payments/${payment.id}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.status(400).render('payments/new', {
        title: 'צ׳ק חדש',
        payable: listPayable(),
        accounts: getDb().prepare('SELECT * FROM bank_accounts ORDER BY display_name').all(),
        values: b,
        error: err.message,
      });
    }
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    res.render('payments/show', {
      title: `צ׳ק #${req.params.id}`,
      payment: getPaymentDetail(Number(req.params.id)),
    });
  } catch (err) {
    next(err);
  }
});

// Stage 4: printable Standard-501 check layout (DRAFT scaffold until bank approval, §11.5).
router.get('/:id/print', (req, res, next) => {
  try {
    const data = getCheckPrintData(Number(req.params.id));
    res.render('payments/print', { title: `הדפסת צ׳ק #${req.params.id}`, ...data });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/clear', (req, res, next) => {
  try {
    markCleared(Number(req.params.id), req.body.cleared_date || null, req.user);
    res.redirect(req.get('referer') || `/payments/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/void', (req, res, next) => {
  try {
    voidPayment(Number(req.params.id), req.user, req.body.reason || null);
    res.redirect(req.get('referer') || `/payments/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

export default router;
