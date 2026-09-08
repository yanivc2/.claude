import { Router } from 'express';
import {
  listTransfers, transferableInvoices, createTransfer, approveTransfer, rejectTransfer,
  cancelTransfer, executeTransfer, untrackedTransfers, getWatchFrom, setWatchFrom,
  transfersReady, TRANSFER_STATUS, statusLabel, watchDefault,
} from '../services/transfers.js';
import { requireOwner } from '../middleware/requireOwner.js';
import { effectiveStoreId } from '../lib/scope.js';
import { assertInScope } from '../lib/scopeGuard.js';
import { RuleError, AuthError } from '../lib/errors.js';
import { config } from '../config.js';

// "העברות בנקאיות" — see services/transfers.js for why this is a REQUEST raised before the bank,
// and why the enforcement is detection (an untracked movement alarms) rather than a lock.
const router = Router();

const NOTICES = {
  created: 'בקשת ההעברה נוצרה וממתינה לאישור הבעלים.',
  approved: 'הבקשה אושרה. אפשר לשחרר את המקבץ בבנק ולרשום את האסמכתה.',
  rejected: 'הבקשה נדחתה.',
  cancelled: 'הבקשה בוטלה.',
  executed: 'ההעברה נרשמה. "נפרע" יתעדכן לבד כשהתנועה תופיע בדף הבנק.',
  bank: 'פרטי הבנק של הספק עודכנו.',
  watch: 'תאריך תחילת המעקב עודכן.',
};

async function render(req, res, extra = {}) {
  const ready = await transfersReady();
  const storeId = effectiveStoreId(req, req.query.store);
  res.render('transfers/index', {
    title: 'העברות בנקאיות',
    ready,
    transfers: ready ? await listTransfers({ scope: req.scope }) : [],
    invoiceOptions: ready ? await transferableInvoices({ storeId, scope: req.scope }) : [],
    untracked: ready ? await untrackedTransfers({ scope: req.scope }) : [],
    watchFrom: ready ? await getWatchFrom() : null,
    watchDefault: watchDefault(),
    approvalTtlDays: config.rules.transferApprovalTtlDays,
    statuses: TRANSFER_STATUS,
    statusLabel,
    notice: NOTICES[req.query.done] || null,
    error: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try { await render(req, res); } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const ids = [].concat(req.body.invoice_ids || []).map(Number).filter(Boolean);
    // Every id comes back through a form: re-check each one against the caller's scope before it
    // becomes an approvable request for money.
    for (const id of ids) await assertInScope('invoice', id, req.scope);
    await createTransfer({ invoiceIds: ids, note: req.body.note }, req.user);
    return res.redirect(303, '/transfers?done=created');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// Approving is the OWNER's one action, and it happens before the money moves.
router.post('/:id/approve', requireOwner, async (req, res, next) => {
  try {
    await approveTransfer(Number(req.params.id), req.user);
    return res.redirect(303, '/transfers?done=approved');
  } catch (err) {
    if (err instanceof RuleError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/:id/reject', requireOwner, async (req, res, next) => {
  try {
    await rejectTransfer(Number(req.params.id), req.body.reason, req.user);
    return res.redirect(303, '/transfers?done=rejected');
  } catch (err) {
    if (err instanceof RuleError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    await cancelTransfer(Number(req.params.id), req.user);
    return res.redirect(303, '/transfers?done=cancelled');
  } catch (err) {
    if (err instanceof RuleError) return render(req, res, { error: err.message });
    next(err);
  }
});

// The one typed field in the whole flow, and only after approval.
router.post('/:id/execute', async (req, res, next) => {
  try {
    await executeTransfer(Number(req.params.id), { reference: req.body.reference, paymentDate: req.body.payment_date }, req.user);
    return res.redirect(303, '/transfers?done=executed');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

// From which date an unrecorded movement is an alarm. Owner-only, and forward-looking by design.
router.post('/watch', requireOwner, async (req, res, next) => {
  try {
    await setWatchFrom(req.body.watch_from, req.user);
    return res.redirect(303, '/transfers?done=watch');
  } catch (err) {
    if (err instanceof RuleError) return render(req, res, { error: err.message });
    next(err);
  }
});

export default router;
