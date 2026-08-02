import { Router } from 'express';
import {
  listTransfers,
  getTransfer,
  createTransfer,
  approveTransferProof,
  executeTransfer,
  cancelTransfer,
  setTransferReference,
  setTransferImage,
  verifyTransfer,
  openInvoicesForMatch,
  transfersSummary,
} from '../services/transfers.js';
import { handleInvoiceImage } from '../middleware/upload.js';
import { getObject } from '../lib/storage.js';
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

router.post('/', handleInvoiceImage, async (req, res, next) => {
  try {
    if (req.uploadError) {
      return res.status(400).render('transfers/new', {
        title: 'העברה חדשה',
        accounts: await bankAccounts(),
        invoices: await openInvoicesForMatch(),
        values: req.body,
        error: req.uploadError,
      });
    }
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
        imagePath: req.file ? req.file.filename : null,
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

// Serve a transfer's proof image (אסמכתא).
router.get('/:id/image', async (req, res, next) => {
  try {
    const tr = await getTransfer(Number(req.params.id));
    if (!tr.image_path) return res.status(404).send('אין תמונה');
    const { buffer, contentType } = await getObject(tr.image_path);
    return res.type(contentType).send(buffer);
  } catch (err) {
    next(err);
  }
});

// Attach or replace a transfer's proof image.
router.post('/:id/image', handleInvoiceImage, async (req, res, next) => {
  try {
    if (req.uploadError) return renderList(res, { error: req.uploadError });
    if (!req.file) return renderList(res, { error: 'לא נבחר קובץ.' });
    await setTransferImage(Number(req.params.id), req.file.filename, req.user);
    res.redirect(303, '/transfers');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

router.post('/:id/verify', async (req, res, next) => {
  try {
    await verifyTransfer(Number(req.params.id), req.user, req.body.undo !== '1');
    res.redirect(303, '/transfers');
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderList(res, { error: err.message });
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
