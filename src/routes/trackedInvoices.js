import { Router } from 'express';
import {
  listTracked, trackInvoice, releaseInvoice, setTrackedNote, trackedReady,
  trackedStatusLabel, trackedMessage, whatsappLink, mailtoLink,
} from '../services/trackedInvoices.js';
import { assertInScope } from '../lib/scopeGuard.js';
import { RuleError, AuthError } from '../lib/errors.js';

// "חשבוניות מעוקבות לתשלום" — מה שמחכה לטיפול של הספק (זיכוי, כמות, מסמך) לפני שסוגרים.
// ראה services/trackedInvoices.js: זה דגל ידני ולא ערך ב-status, כי status מנוהל אוטומטית.
const router = Router();

const FILTER_KEYS = ['supplier', 'number', 'amount', 'from', 'to'];

router.get('/', async (req, res, next) => {
  try {
    // בין הפריסה ללחיצה על "עדכן מסד נתונים" העמודות עוד לא קיימות. לומר את זה, לא ליפול על
    // "column i.tracked_for_payment does not exist".
    const ready = await trackedReady();
    const filters = Object.fromEntries(FILTER_KEYS.map((k) => [k, req.query[k] ? String(req.query[k]) : '']));
    const rows = ready ? await listTracked({ scope: req.scope, filters }) : [];
    res.render('tracked/index', {
      title: 'חשבוניות מעוקבות לתשלום',
      rows: rows.map((r) => ({
        ...r,
        statusInfo: trackedStatusLabel(r),
        waHref: whatsappLink(r),
        mailHref: mailtoLink(r),
        messageText: trackedMessage(r),
      })),
      filters,
      filtered: FILTER_KEYS.some((k) => filters[k]),
      needsUpgrade: !ready,
      notice: req.query.saved === 'note' ? 'ההסבר נשמר.'
        : req.query.saved === 'released' ? 'החשבונית שוחררה מעיקוב ואינה מופיעה כאן יותר.' : null,
      error: req.query.err ? String(req.query.err) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/note', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    await assertInScope('invoice', id, req.scope);
    await setTrackedNote(id, req.body.note, req.user);
    return res.redirect(303, '/tracked-invoices?saved=note');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.redirect(303, `/tracked-invoices?err=${encodeURIComponent(err.message)}`);
    }
    next(err);
  }
});

router.post('/:id/release', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    await assertInScope('invoice', id, req.scope);
    await releaseInvoice(id, req.user);
    return res.redirect(303, '/tracked-invoices?saved=released');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.redirect(303, `/tracked-invoices?err=${encodeURIComponent(err.message)}`);
    }
    next(err);
  }
});

// עיקוב חשבונית קיימת (מדף החשבונית). חשבונית חדשה מסומנת דרך הכפתור בטופס — routes/invoices.js.
router.post('/:id/track', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    await assertInScope('invoice', id, req.scope);
    await trackInvoice(id, { note: req.body.note }, req.user);
    return res.redirect(303, '/tracked-invoices');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.redirect(303, `/invoices/${id}?err=${encodeURIComponent(err.message)}`);
    }
    next(err);
  }
});

export default router;
