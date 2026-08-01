import { Router } from 'express';
import {
  listTransfers,
  createTransfer,
  approveTransferProof,
  executeTransfer,
  cancelTransfer,
  setTransferReference,
  openInvoicesForMatch,
  transfersSummary,
} from '../services/transfers.js';
import { getExecutor } from '../db/adapter.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

/** Bank accounts for the filter + form dropdowns. */
async function bankAccounts() {
  return getExecutor().many(
    `SELECT ba.id, ba.display_name, c.name AS company_name, st.name AS store_name
       FROM bank_accounts ba
       JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
      ORDER BY c.name, st.name`,
    [],
  );
}

async function renderList(res, extra = {}) {
  const status = extra.filter || null;
  const accountId = extra.accountId || null;
  res.render('transfers/index', {
    title: 'העברות בנקאיות',
    transfers: await listTransfers({ status, accountId }),
    accounts: await bankAccounts(),
    summary: await transfersSummary(),
    filter: status || '',
    accountId: accountId || '',
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    const status = ['scheduled', 'executed', 'cancelled'].includes(req.query.status) ? req.query.status : null;
    const accountId = req.query.account ? Number(req.query.account) : null;
    const notice = req.query.created ? 'ההעברה נקלטה ונקבעה כמתוזמנת — ממתינה לאישור אסמכתא.' : null;
    await renderList(res, { filter: status, accountId, notice });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    res.render('transfers/new', {
      title: 'העברה חדשה',
      accounts: await bankAccounts(),
      invoices: await openInvoicesForMatch(),
      values: {},
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const transfer = await createTransfer(
      {
        bankAccountId: req.body.bank_account_id,
        payee: req.body.payee,
        amount: req.body.amount,
        transferDate: req.body.transfer_date,
        reference: req.body.reference,
        recurrence: req.body.recurrence,
        invoiceId: req.body.invoice_id || null,
        matchType: req.body.match_type,
        matchNote: req.body.match_note,
        notes: req.body.notes,
      },
      req.user,
    );
    res.redirect(303, `/transfers?created=${transfer.id}`);
  } catch (err) {
    if (err instanceof RuleError) {
      return res.status(400).render('transfers/new', {
        title: 'העברה חדשה',
        accounts: await bankAccounts(),
        invoices: await openInvoicesForMatch(),
        values: req.body,
        error: err.message,
      });
    }
    next(err);
  }
});

router.post('/:id/reference', async (req, res, next) => {
  try {
    await setTransferReference(Number(req.params.id), req.body.reference, req.user);
    res.redirect(303, '/transfers');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    await approveTransferProof(Number(req.params.id), req.user);
    res.redirect(303, '/transfers');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

router.post('/:id/execute', async (req, res, next) => {
  try {
    await executeTransfer(Number(req.params.id), req.user);
    res.redirect(303, '/transfers');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

router.post('/:id/cancel', async (req, res, next) => {
  try {
    await cancelTransfer(Number(req.params.id), req.user, req.body.reason || null);
    res.redirect(303, '/transfers');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

export default router;
