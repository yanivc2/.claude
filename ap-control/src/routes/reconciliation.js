import { Router } from 'express';
import multer from 'multer';
import { getExecutor } from '../db/adapter.js';
import { toAgorot } from '../lib/money.js';
import { parseCsv } from '../lib/csv.js';
import { normalizeBankRows } from '../lib/bankCsv.js';
import { RuleError } from '../lib/errors.js';
import {
  importTransactions,
  listUnmatched,
  listTransactions,
} from '../services/bankTransactions.js';
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

async function accounts() {
  return getExecutor().many(
    `SELECT ba.*, c.name AS company_name, st.name AS store_name
       FROM bank_accounts ba JOIN companies c ON c.id = ba.company_id
       JOIN stores st ON st.id = ba.store_id ORDER BY c.name, st.name`,
    [],
  );
}

async function resolveAccountId(req) {
  const all = await accounts();
  const requested = Number(req.query.account);
  return all.some((a) => a.id === requested) ? requested : all[0]?.id;
}

async function renderPage(req, res, accountId, extra = {}) {
  const unmatched = accountId ? await listUnmatched(accountId) : [];
  const classified = await Promise.all(unmatched.map(async (t) => ({ txn: t, ...(await classify(t)) })));
  res.render('reconciliation/index', {
    title: 'התאמת בנק',
    accounts: await accounts(),
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

// CSV import. Expected headers: date, amount, description, reference.
router.post('/import-csv', (req, res, next) => {
  csvUpload(req, res, async (uploadErr) => {
    const accountId = Number(req.body.account_id) || (await resolveAccountId(req));
    try {
      if (uploadErr) throw new RuleError('CSV', 'העלאת הקובץ נכשלה');
      if (!req.file) throw new RuleError('CSV', 'לא נבחר קובץ CSV');
      let mapped;
      try {
        mapped = normalizeBankRows(parseCsv(req.file.buffer.toString('utf8')));
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
router.post('/add', async (req, res, next) => {
  const accountId = Number(req.body.account_id) || (await resolveAccountId(req));
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
  const accountId = Number(req.body.account_id) || (await resolveAccountId(req));
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
  const accountId = Number(req.body.account_id) || (await resolveAccountId(req));
  try {
    await confirmMatch(Number(req.body.txn_id), Number(req.body.payment_id), req.user);
    await renderPage(req, res, accountId, { notice: 'הצ׳ק סומן כנפרע.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/unmatch', async (req, res, next) => {
  const accountId = Number(req.body.account_id) || (await resolveAccountId(req));
  try {
    await unmatch(Number(req.body.txn_id), req.user);
    await renderPage(req, res, accountId, { notice: 'ההתאמה בוטלה, הצ׳ק חזר לסטטוס פתוח.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

export default router;
