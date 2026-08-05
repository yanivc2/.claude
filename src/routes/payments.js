import { Router } from 'express';
import {
  createPayment,
  markCleared,
  markIssued,
  voidPayment,
  getPaymentDetail,
  getCheckPrintData,
  listPayments,
} from '../services/payments.js';
import { listPayable } from '../services/invoices.js';
import { listDeposits } from '../services/deposits.js';
import { autoReconcile, reconcileDeposits } from '../services/reconciliation.js';
import { getExecutor } from '../db/adapter.js';
import { scopeClause } from '../lib/scope.js';
import { scopeParam } from '../lib/scopeGuard.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

// Company-separation guard: every /payments/:id route (view, print, clear, void) is refused
// with 404 when the payment belongs to a company the caller isn't authorized for.
router.param('id', scopeParam('payment'));

router.get('/', async (req, res, next) => {
  try {
    const companyId = req.query.company ? Number(req.query.company) : null;
    const storeId = req.query.store ? Number(req.query.store) : null;
    const scope = req.scope.companyIds;
    const cScope = scopeClause(scope, 'id');
    const sScope = scopeClause(scope, 'st.company_id');
    const x = getExecutor();
    // Auto-reconcile summary is passed back via the query string (rc=1) after a run.
    let notice = null;
    if (req.query.rc) {
      const m = Number(req.query.m) || 0;
      const a = Number(req.query.a) || 0;
      const u = Number(req.query.u) || 0;
      const dep = Number(req.query.dep) || 0;
      notice = `הותאמו אוטומטית ${m} צ׳קים · ${a} דורשים הכרעה · ${u} ללא התאמה` + (dep ? ` · ${dep} הפקדות הותאמו לפי מספר שקית.` : '.');
    }
    res.render('payments/index', {
      title: 'מרקורים',
      payments: await listPayments({ status: req.query.status || null, companyId, storeId, scope }),
      deposits: await listDeposits({ storeId, scope, limit: 50 }),
      filter: req.query.status || '',
      companyId,
      storeId,
      notice,
      companies: await x.many(`SELECT id, name FROM companies WHERE 1 = 1${cScope.sql} ORDER BY name`, [...cScope.params]),
      stores: await x.many(
        `SELECT st.id, st.name, st.company_id, ba.display_name AS bank_account_name
           FROM stores st LEFT JOIN bank_accounts ba ON ba.store_id = st.id
          WHERE 1 = 1${sScope.sql} ORDER BY st.name`,
        [...sScope.params],
      ),
    });
  } catch (err) {
    next(err);
  }
});

// Auto-reconcile (R7) every open check in view against imported bank transactions —
// the same engine as the reconciliation page, but callable from the payments list.
// Honours the current company/store filter; otherwise runs on all in-scope accounts.
router.post('/auto-reconcile', async (req, res, next) => {
  try {
    const companyId = req.body.company ? Number(req.body.company) : null;
    const storeId = req.body.store ? Number(req.body.store) : null;
    const sScope = scopeClause(req.scope.companyIds, 'ba.company_id');
    const params = [...sScope.params];
    let sql = `SELECT ba.id FROM bank_accounts ba WHERE 1 = 1${sScope.sql}`;
    if (companyId) { sql += ' AND ba.company_id = ?'; params.push(companyId); }
    if (storeId) { sql += ' AND ba.store_id = ?'; params.push(storeId); }
    const accounts = await getExecutor().many(sql, params);

    let m = 0;
    let a = 0;
    let u = 0;
    let dep = 0;
    for (const acc of accounts) {
      const r = await autoReconcile(acc.id, req.user);
      m += r.matched;
      a += r.ambiguous;
      u += r.unmatched;
      const rd = await reconcileDeposits(acc.id, req.user);
      dep += rd.matched;
    }

    const q = new URLSearchParams({ rc: '1', m: String(m), a: String(a), u: String(u), dep: String(dep) });
    if (req.body.status) q.set('status', req.body.status);
    if (companyId) q.set('company', String(companyId));
    if (storeId) q.set('store', String(storeId));
    res.redirect(303, `/payments?${q.toString()}`);
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

router.post('/:id/unclear', async (req, res, next) => {
  try {
    await markIssued(Number(req.params.id), req.user);
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
