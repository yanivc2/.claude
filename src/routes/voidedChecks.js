import { Router } from 'express';
import {
  listVoidedChecks, VOID_REASONS, voidReasonLabel, CHECK_LIFE_DAYS, voidLinkOptions, setVoidLink,
  voidedChecksReady,
} from '../services/voidedChecks.js';
import { assertInScope } from '../lib/scopeGuard.js';

// "צ'קים מבוטלים" — one rubric per store. Read-only: a check gets here by being voided with a
// reason on its own payment page, and leaves the danger list by the calendar, so there is nothing
// to edit here. See services/voidedChecks.js for why a voided check still needs watching.
const router = Router();

router.get('/', async (req, res, next) => {
  try {
    // Between the deploy and the owner clicking "עדכן מסד נתונים" the columns do not exist yet.
    // Say so, rather than showing "column p.voided_by does not exist".
    const ready = await voidedChecksReady();
    const groups = ready ? await listVoidedChecks({ scope: req.scope }) : [];
    // The link a row still owes is picked HERE, not at void time: the replacement payment can only
    // be recorded after the check is voided (the invoice was still paid until then). Only rows
    // that actually owe one carry options, so the page does not fetch for every row.
    for (const g of ready ? groups : []) {
      for (const r of g.rows) {
        r.linkOptions = r.status.key === 'unlinked' ? await voidLinkOptions(r.id) : null;
      }
    }
    res.render('voided-checks/index', {
      title: 'צ׳קים מבוטלים',
      groups,
      reasons: VOID_REASONS,
      voidReasonLabel,
      checkLifeDays: CHECK_LIFE_DAYS,
      needsUpgrade: !ready,
      notice: req.query.linked ? 'הקישור נשמר.' : null,
    });
  } catch (err) {
    next(err);
  }
});

// Attach the missing link (see services/voidedChecks.js#setVoidLink).
router.post('/:id/link', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await assertInScope('payment', id, req.scope);
    const linkPaymentId = Number(req.body.link_payment_id) || null;
    const linkInvoiceId = Number(req.body.link_invoice_id) || null;
    // A forged id must not tie this void to another company's row.
    if (linkPaymentId) await assertInScope('payment', linkPaymentId, req.scope);
    if (linkInvoiceId) await assertInScope('invoice', linkInvoiceId, req.scope);
    await setVoidLink(id, { linkPaymentId, linkInvoiceId }, req.user);
    return res.redirect(303, '/voided-checks?linked=1');
  } catch (err) {
    next(err);
  }
});

export default router;
