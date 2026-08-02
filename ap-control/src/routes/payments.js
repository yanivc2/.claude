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
import { getExecutor } from '../db/adapter.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const companyId = req.query.company ? Number(req.query.company) : null;
    const storeId = req.query.store ? Number(req.query.store) : null;
    const x = getExecutor();
    res.render('payments/index', {
      title: 'תשלומים (צ׳קים)',
      payments: await listPayments({ status: req.query.status || null, companyId, storeId }),
      filter: req.query.status || '',
      companyId,
      storeId,
      companies: await x.many('SELECT id, name FROM companies ORDER BY name', []),
      stores: await x.many('SELECT id, name, company_id FROM stores ORDER BY name', []),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const methods = ['check', 'cash', 'credit', 'transfer', 'batch'];
    const method = methods.includes(req.query.method) ? req.query.method : 'check';
    const preselectId = req.query.invoice ? Number(req.query.invoice) : null;
    res.render('payments/new', {
      title: 'תשלום חדש',
      payable: await listPayable(),
      accounts: await getExecutor().many('SELECT * FROM bank_accounts ORDER BY display_name', []),
      values: { method },
      preselectId,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  const b = req.body;
  const invoiceIds = []
    .concat(b.invoice_ids || [])
    .map(Number)
    .filter(Boolean);
  try {
    const payment = await createPayment(
      {
        bankAccountId: Number(b.bank_account_id),
        method: b.method || 'check',
        checkNumber: b.check_number,
        reference: b.reference,
        payerName: b.payer_name,
        cardLast4: b.card_last4,
        batchNumber: b.batch_number,
        paymentDate: b.payment_date,
        invoiceIds,
      },
      req.user,
    );
    res.redirect(303, `/payments/${payment.id}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.status(400).render('payments/new', {
        title: 'תשלום חדש',
        payable: await listPayable(),
        accounts: await getExecutor().many('SELECT * FROM bank_accounts ORDER BY display_name', []),
        values: b,
        preselectId: null,
        error: err.message,
      });
    }
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.render('payments/show', {
      title: `צ׳ק #${req.params.id}`,
      payment: await getPaymentDetail(Number(req.params.id)),
    });
  } catch (err) {
    next(err);
  }
});

// Stage 4: printable Standard-501 check layout (DRAFT scaffold until bank approval, §11.5).
router.get('/:id/print', async (req, res, next) => {
  try {
    const data = await getCheckPrintData(Number(req.params.id));
    res.render('payments/print', { title: `הדפסת צ׳ק #${req.params.id}`, ...data });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/clear', async (req, res, next) => {
  try {
    await markCleared(Number(req.params.id), req.body.cleared_date || null, req.user);
    res.redirect(303, req.get('referer') || `/payments/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/void', async (req, res, next) => {
  try {
    await voidPayment(Number(req.params.id), req.user, req.body.reason || null);
    res.redirect(303, req.get('referer') || `/payments/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

export default router;
