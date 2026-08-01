import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/index.js';
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

function accounts() {
  return getDb()
    .prepare(
      `SELECT ba.*, c.name AS company_name, st.name AS store_name
         FROM bank_accounts ba JOIN companies c ON c.id = ba.company_id
         JOIN stores st ON st.id = ba.store_id ORDER BY c.name, st.name`,
    )
    .all();
}

function resolveAccountId(req) {
  const all = accounts();
  const requested = Number(req.query.account);
  return all.some((a) => a.id === requested) ? requested : all[0]?.id;
}

function renderPage(req, res, accountId, extra = {}) {
  const unmatched = accountId ? listUnmatched(accountId) : [];
  const classified = unmatched.map((t) => ({ txn: t, ...classify(t) }));
  res.render('reconciliation/index', {
    title: 'התאמת בנק',
    accounts: accounts(),
    accountId,
    classified,
    transactions: accountId ? listTransactions(accountId) : [],
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', (req, res) => {
  renderPage(req, res, resolveAccountId(req));
});

// CSV import. Expected headers: date, amount, description, reference.
// `amount` is signed shekels (a debit / cleared check is negative).
router.post('/import-csv', (req, res, next) => {
  csvUpload(req, res, (uploadErr) => {
    const accountId = Number(req.body.account_id) || resolveAccountId(req);
    try {
      if (uploadErr) throw new RuleError('CSV', 'העלאת הקובץ נכשלה');
      if (!req.file) throw new RuleError('CSV', 'לא נבחר קובץ CSV');
      // Supports the real Bank Hapoalim export (Hebrew headers, חובה/זכות, אסמכתא=check no.)
      // as well as a simple date/amount/description/reference CSV.
      let mapped;
      try {
        mapped = normalizeBankRows(parseCsv(req.file.buffer.toString('utf8')));
      } catch (e) {
        throw new RuleError('CSV', e.message);
      }
      if (mapped.length === 0) throw new RuleError('CSV', 'לא נמצאו תנועות בקובץ');
      const { inserted, skipped } = importTransactions(accountId, mapped, 'csv', req.user);
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
router.post('/add', (req, res, next) => {
  const accountId = Number(req.body.account_id) || resolveAccountId(req);
  try {
    importTransactions(
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
    renderPage(req, res, accountId, { notice: 'התנועה נוספה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/auto', (req, res, next) => {
  const accountId = Number(req.body.account_id) || resolveAccountId(req);
  try {
    const r = autoReconcile(accountId, req.user);
    renderPage(req, res, accountId, {
      notice: `הותאמו אוטומטית ${r.matched} צ׳קים · ${r.ambiguous} דורשים הכרעה · ${r.unmatched} ללא התאמה.`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/match', (req, res, next) => {
  const accountId = Number(req.body.account_id) || resolveAccountId(req);
  try {
    confirmMatch(Number(req.body.txn_id), Number(req.body.payment_id), req.user);
    renderPage(req, res, accountId, { notice: 'הצ׳ק סומן כנפרע.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

router.post('/unmatch', (req, res, next) => {
  const accountId = Number(req.body.account_id) || resolveAccountId(req);
  try {
    unmatch(Number(req.body.txn_id), req.user);
    renderPage(req, res, accountId, { notice: 'ההתאמה בוטלה, הצ׳ק חזר לסטטוס פתוח.' });
  } catch (err) {
    if (err instanceof RuleError) return renderPage(req, res, accountId, { error: err.message });
    next(err);
  }
});

export default router;
