import { Router } from 'express';
import multer from 'multer';
import { getExecutor } from '../db/adapter.js';
import { scopeClause } from '../lib/scope.js';
import { assertInScope } from '../lib/scopeGuard.js';
import { toAgorot } from '../lib/money.js';
import { parseCsv } from '../lib/csv.js';
import { parseXlsx } from '../lib/xlsx.js';
import { normalizeBankRows } from '../lib/bankCsv.js';
import { decodeBuffer } from '../lib/decodeText.js';
import { RuleError } from '../lib/errors.js';
import { requirePermission } from '../middleware/requireOwner.js';
import {
  importTransactions,
  listUnmatched,
  listTransactions,
  deleteTransaction,
  editTransaction,
  getTransaction,
} from '../services/bankTransactions.js';
import { submitRequest } from '../services/changeRequests.js';
import { describeBankTxn } from '../lib/changeSummary.js';
import {
  classify,
  confirmMatch,
  unmatch,
  autoReconcile,
} from '../services/reconciliation.js';

const router = Router();

const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single('csv');

// A .xlsx is a ZIP archive — its first bytes are the local-file-header magic "PK\x03\x04".
// Detect by content (robust to a wrong/missing extension from a phone) or by name.
function looksLikeXlsx(file) {
  const name = (file.originalname || '').toLowerCase();
  if (name.endsWith('.xlsx')) return true;
  const b = file.buffer;
  return !!b && b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

async function accounts(scope = null) {
  const sc = scopeClause(scope, 'ba.company_id');
  return getExecutor().many(
    `SELECT ba.*, c.name AS company_name, st.name AS store_name
       FROM bank_accounts ba JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id
      WHERE 1 = 1${sc.sql} ORDER BY c.name, st.name`,
    [...sc.params],
  );
}

// Resolve the account to act on from body.account_id (form POST) or ?account= (GET), but ONLY if
// it is one the caller is authorized to see — a forged/foreign id falls back to the first
// authorized account, never acting cross-company. This is the single scope gate for account_id.
async function resolveAccountId(req) {
  const all = await accounts(req.scope.companyIds);
  const requested = Number(req.body?.account_id) || Number(req.query.account);
  return all.some((a) => a.id === requested) ? requested : all[0]?.id;
}

async function renderPage(req, res, accountId, extra = {}) {
  const unmatched = accountId ? await listUnmatched(accountId) : [];
  const classified = await Promise.all(unmatched.map(async (t) => ({ txn: t, ...(await classify(t)) })));
  res.render('reconciliation/index', {
    title: 'התאמת בנק',
    accounts: await accounts(req.scope.companyIds),
    accountId,
    classified,
    transactions: accountId ? await listTransactions(accountId) : [],
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    await renderPage(req, res, await resolveAccountId(req));
  } catch (err) {
    next(err);
  }
});

// Statement import — CSV or Excel (.xlsx). Recognised bank columns:
// תאריך / חובה / זכות (or תאריך / סכום), plus אסמכתא and a description column.
router.post('/import-csv', requirePermission('import_bank'), (req, res, next) => {
  csvUpload(req, res, async (uploadErr) => {
    const accountId = await resolveAccountId(req);
    try {
      if (uploadErr) throw new RuleError('CSV', 'העלאת הקובץ נכשלה');
      if (!req.file) throw new RuleError('CSV', 'לא נבחר קובץ');
      let mapped;
      try {
        const rows = looksLikeXlsx(req.file)
          ? parseXlsx(req.file.buffer)
          : parseCsv(decodeBuffer(req.file.buffer));
        mapped = normalizeBankRows(rows);
      } catch (e) {
        throw new RuleError('CSV', e.message);
      }
      if (mapped.length === 0) throw new RuleError('CSV', 'לא נמצאו תנועות בקובץ');
      const { inserted, skipped } = await importTransactions(accountId, mapped, 'csv', req.user);
      return renderPage(req, res, accountId, {
        notice: `יובאו ${inserted} תנועות חדשות, ${skipped} כבר היו קיימות.`,
      });
    } catch (err) {
      if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
      next(err);
    }
  });
});

// Manual single transaction (signed shekels, debit negative).
router.post('/add', requirePermission('import_bank'), async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    await importTransactions(
      accountId,
      [
        {
          txnDate: req.body.txn_date,
          amount: toAgorot(req.body.amount),
          description: req.body.description || null,
          rawReference: req.body.reference || null,
        },
      ],
      'manual',
      req.user,
    );
    await renderPage(req, res, accountId, { notice: 'התנועה נוספה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/auto', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    const r = await autoReconcile(accountId, req.user);
    await renderPage(req, res, accountId, {
      notice: `הותאמו אוטומטית ${r.matched} צ׳קים · ${r.ambiguous} דורשים הכרעה · ${r.unmatched} ללא התאמה.`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/match', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    // Scope guard: the transaction and the payment must both belong to the caller's companies —
    // a forged txn_id/payment_id from another company is refused (404, existence not leaked).
    await assertInScope('bankTxn', Number(req.body.txn_id), req.scope.companyIds);
    await assertInScope('payment', Number(req.body.payment_id), req.scope.companyIds);
    await confirmMatch(Number(req.body.txn_id), Number(req.body.payment_id), req.user);
    await renderPage(req, res, accountId, { notice: 'הצ׳ק סומן כנפרע.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/txn/:id/edit', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  const id = Number(req.params.id);
  try {
    await assertInScope('bankTxn', id, req.scope.companyIds);
    const fields = {
      txnDate: req.body.txn_date,
      amount: toAgorot(req.body.amount),
      description: req.body.description || null,
      rawReference: req.body.reference || null,
    };
    // Non-owners: queue the edit for approval.
    if (req.user.role !== 'owner') {
      const current = await getTransaction(id);
      await submitRequest(
        { action: 'bank_txn.edit', entityType: 'bank_transaction', entityId: id, payload: { id, fields }, summary: describeBankTxn(current, fields) },
        req.user,
      );
      return renderPage(req, res, accountId, { notice: 'בקשת העריכה נשלחה לאישור הבעלים.' });
    }
    await editTransaction(id, fields, req.user);
    await renderPage(req, res, accountId, { notice: 'התנועה עודכנה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/txn/:id/delete', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    await assertInScope('bankTxn', Number(req.params.id), req.scope.companyIds);
    await deleteTransaction(Number(req.params.id), req.user);
    await renderPage(req, res, accountId, { notice: 'התנועה נמחקה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/unmatch', async (req, res, next) => {
  const accountId = await resolveAccountId(req);
  try {
    await assertInScope('bankTxn', Number(req.body.txn_id), req.scope.companyIds);
    await unmatch(Number(req.body.txn_id), req.user);
    await renderPage(req, res, accountId, { notice: 'ההתאמה בוטלה, הצ׳ק חזר לסטטוס פתוח.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

export default router;
