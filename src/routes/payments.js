import { Router } from 'express';
import {
  createPayment,
  updatePayment,
  markCleared,
  markIssued,
  voidPayment,
  voidPaymentWithReason,
  getPaymentDetail,
  getCheckPrintData,
  listPayments,
} from '../services/payments.js';
import { listPayable } from '../services/invoices.js';
import { listDeposits } from '../services/deposits.js';
import { cashExpensesByStore } from '../services/zclosing.js';
import { autoReconcile, reconcileDeposits } from '../services/reconciliation.js';
import { getExecutor } from '../db/adapter.js';
import { scopeClause, scopeWhere, effectiveStoreId } from '../lib/scope.js';
import { scopeParam, assertInScope } from '../lib/scopeGuard.js';
import { requirePermission, requireOwner } from '../middleware/requireOwner.js';
import { RuleError, AuthError } from '../lib/errors.js';
import { toAgorot } from '../lib/money.js';
import { listSuppliers } from '../services/suppliers.js';
import { listEmployees } from '../services/employees.js';
import { VOID_REASONS, voidLinkOptions } from '../services/voidedChecks.js';
import { paymentAllocation, openInvoicesForPayment, allocateInvoiceToPayments } from '../services/allocations.js';

const router = Router();

// Bank accounts the caller may pick from — scoped to their authorized companies AND stores
// (owner = all). Accepts the req.scope object so a per-store-granted user only sees their stores'
// accounts in the new-payment dropdown.
async function scopedAccounts(scope) {
  const sc = scopeWhere(scope, 'company_id', 'store_id');
  return getExecutor().many(
    `SELECT * FROM bank_accounts WHERE 1 = 1${sc.sql} ORDER BY display_name`,
    [...sc.params],
  );
}

// Company-separation guard: every /payments/:id route (view, print, clear, void) is refused
// with 404 when the payment belongs to a company the caller isn't authorized for.
router.param('id', scopeParam('payment'));

router.get('/', async (req, res, next) => {
  try {
    const companyId = req.query.company ? Number(req.query.company) : null;
    // Default to the active-store context unless an explicit ?store= overrides it.
    const storeId = effectiveStoreId(req, req.query.store);
    const scope = req.scope;
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
      // "הוצאות מזומן מהקופה" — מקובץ לפי חנות, משני מקומות ההזנה (services/zclosing.js).
      cashByStore: await cashExpensesByStore(scope, 200),
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
    // Honour the active-store context: after switching store the screen shows THAT store only.
    // With no active store ("all stores") every store is shown, collapsed (see the view).
    const all = await listPayable(req.scope);
    const payable = req.activeStoreId ? all.filter((i) => Number(i.store_id) === req.activeStoreId) : all;
    res.render('payments/new', {
      title: 'תשלום חדש',
      payable,
      addedNotice: req.query.added === '1' ? 'התשלום נרשם. אפשר להזין את הבא.' : null,
      accounts: await scopedAccounts(req.scope),
      suppliers: await listSuppliers('approved', undefined, { scope: req.scope }),
      // "שם המשלם" on a cash payment is picked from the staff list, never typed — see the view.
      employeeOptions: await listEmployees({ scope: req.scope }),
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
    // Company scope: refuse a forged bank_account_id from a company the caller isn't authorized
    // for (cross-company IDOR on POST). Owners have scope=null → allowed. 404 hides existence.
    await assertInScope('bankAccount', Number(b.bank_account_id), req.scope);
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
        // Advance (R8): no invoices, but a supplier and a typed amount. The invoice is attached
        // later from its own page. createPayment refuses an amount when invoices ARE selected.
        supplierId: invoiceIds.length ? null : Number(b.advance_supplier_id) || null,
        amount: invoiceIds.length ? null : (b.advance_amount ? toAgorot(b.advance_amount) : null),
      },
      req.user,
    );
    // "שמור והוסף עוד תשלום" — stay on the form for the next check instead of opening this one.
    if (b.add_another) return res.redirect(303, '/payments/new?added=1');
    res.redirect(303, `/payments/${payment.id}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.status(400).render('payments/new', {
        title: 'תשלום חדש',
        payable: await listPayable(req.scope),
        addedNotice: null,
        accounts: await scopedAccounts(req.scope),
        suppliers: await listSuppliers('approved', undefined, { scope: req.scope }),
        employeeOptions: await listEmployees({ scope: req.scope }),
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
    const id = Number(req.params.id);
    const payment = await getPaymentDetail(id);
    const alloc = await paymentAllocation(id);
    // R8, the other direction: money still on account here can be attached to open invoices of
    // the same supplier family without leaving this screen.
    const openInvoices = alloc.unallocated > 0 && payment.status === 'issued'
      ? await openInvoicesForPayment(id)
      : [];
    res.render('payments/show', {
      title: `צ׳ק #${req.params.id}`,
      payment,
      alloc,
      openInvoices,
      voidReasons: VOID_REASONS,
      // What a void may be linked to — derived from this check's own invoices/supplier, so the
      // picker cannot offer an unrelated row. See services/voidedChecks.js#voidLinkOptions.
      voidLinks: payment.status === 'issued' ? await voidLinkOptions(Number(req.params.id)) : { payments: [], invoices: [] },
      notice: req.query.alloc ? String(req.query.alloc) : null,
      error: req.query.allocfail ? String(req.query.allocfail) : null,
    });
  } catch (err) {
    next(err);
  }
});

// Attach open invoices to THIS payment's remaining balance (the mirror of the invoice screen's
// panel). Each invoice is allocated in turn, so one check can close several small invoices.
router.post('/:id/allocate', requirePermission('approve_payment'), async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    await assertInScope('payment', id, req.scope);
    const invoiceIds = [].concat(req.body.invoice_ids || []).map(Number).filter(Boolean);
    if (!invoiceIds.length) throw new RuleError('R8', 'לא נבחרו חשבוניות לשיוך');
    let applied = 0;
    for (const invId of invoiceIds) {
      const r = await allocateInvoiceToPayments(invId, [{ paymentId: id }], req.user);
      applied += r.applied;
    }
    const left = (await paymentAllocation(id)).unallocated;
    const msg = `שויכו ${(applied / 100).toFixed(2)} ₪` + (left > 0 ? ` — נותרה יתרה על החשבון: ${(left / 100).toFixed(2)} ₪.` : ' — התשלום מנוצל במלואו.');
    return res.redirect(303, `/payments/${id}?alloc=${encodeURIComponent(msg)}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.redirect(303, `/payments/${id}?allocfail=${encodeURIComponent(err.message)}`);
    }
    next(err);
  }
});

// Edit a payment's method / identifier / date, and (for an issued, not-bank-matched payment)
// re-target which invoices it applies to — e.g. add a credit note so the net = the real check.
async function retargetData(payment) {
  if (payment.status !== 'issued' || !payment.lines.length) return { canRetarget: false, candidates: [] };
  const x = getExecutor();
  const matched = await x.one('SELECT 1 AS m FROM bank_transactions WHERE matched_payment_id = ? LIMIT 1', [payment.id]);
  if (matched) return { canRetarget: false, candidates: [] };
  const anyInv = await x.one('SELECT supplier_id, store_id FROM invoices WHERE id = ?', [payment.lines[0].invoice_id]);
  if (!anyInv) return { canRetarget: false, candidates: [] };
  const appliedIds = new Set(payment.lines.map((l) => l.invoice_id));
  const applied = payment.lines.map((l) => ({ id: l.invoice_id, invoice_number: l.invoice_number, doc_type: l.doc_type, invoice_date: l.invoice_date, total_amount: l.amount_applied, applied: true }));
  const open = (await listPayable())
    .filter((i) => i.supplier_id === anyInv.supplier_id && i.store_id === anyInv.store_id && !appliedIds.has(i.id))
    .map((i) => ({ id: i.id, invoice_number: i.invoice_number, doc_type: i.doc_type, invoice_date: i.invoice_date, total_amount: i.total_amount, applied: false }));
  return { canRetarget: true, candidates: [...applied, ...open] };
}

// Editing an already-recorded payment method is OWNER-ONLY — a human-error escape hatch. The
// business rule is: once a payment (check/transfer/cash/…) is recorded you don't edit it, you void
// and reissue. The owner keeps edit for the one recurring mistake (a credit note entered after the
// check amount was already recorded), which the re-target flow fixes by recomputing the net.
router.get('/:id/edit', requireOwner, async (req, res, next) => {
  try {
    const payment = await getPaymentDetail(Number(req.params.id));
    res.render('payments/edit', { title: `עריכת תשלום #${payment.id}`, payment, employeeOptions: await listEmployees({ scope: req.scope }), ...(await retargetData(payment)), error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/edit', requireOwner, async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const b = req.body;
    const invoiceIds = [].concat(b.invoice_ids || []).map(Number).filter(Boolean);
    await updatePayment(id, {
      method: b.method,
      checkNumber: b.check_number,
      reference: b.reference,
      payerName: b.payer_name,
      cardLast4: b.card_last4,
      batchNumber: b.batch_number,
      paymentDate: b.payment_date,
      invoiceIds,
    }, req.user);
    res.redirect(303, `/payments/${id}`);
  } catch (err) {
    if (err instanceof RuleError) {
      const payment = await getPaymentDetail(id);
      return res.status(400).render('payments/edit', { title: `עריכת תשלום #${id}`, payment, employeeOptions: await listEmployees({ scope: req.scope }), ...(await retargetData(payment)), error: err.message });
    }
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
    // A void now carries its structured reason (see services/voidedChecks.js). An old form or a
    // caller that sends none still voids — it just has no follow-up to chase.
    // A forged link id must not tie this void to another company's row: the picker only offers
    // rows from this check, but the id comes back through the form like any other.
    const linkPaymentId = Number(req.body.link_payment_id) || null;
    const linkInvoiceId = Number(req.body.link_invoice_id) || null;
    if (linkPaymentId) await assertInScope('payment', linkPaymentId, req.scope);
    if (linkInvoiceId) await assertInScope('invoice', linkInvoiceId, req.scope);
    await voidPaymentWithReason(
      Number(req.params.id),
      {
        reason: req.body.void_reason || null,
        note: req.body.reason || null,
        linkPaymentId,
        linkInvoiceId,
      },
      req.user,
    );
    res.redirect(303, req.get('referer') || `/payments/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

export default router;
