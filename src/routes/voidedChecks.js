import { Router } from 'express';
import { listVoidedChecks, VOID_REASONS, voidReasonLabel, CHECK_LIFE_DAYS } from '../services/voidedChecks.js';

// "צ'קים מבוטלים" — one rubric per store. Read-only: a check gets here by being voided with a
// reason on its own payment page, and leaves the danger list by the calendar, so there is nothing
// to edit here. See services/voidedChecks.js for why a voided check still needs watching.
const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const groups = await listVoidedChecks({ scope: req.scope });
    res.render('voided-checks/index', {
      title: 'צ׳קים מבוטלים',
      groups,
      reasons: VOID_REASONS,
      voidReasonLabel,
      checkLifeDays: CHECK_LIFE_DAYS,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
