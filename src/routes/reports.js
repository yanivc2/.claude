import { Router } from 'express';
import {
  outstandingChecks,
  outstandingChecksForAccount,
  invoiceLookup,
  profitability,
} from '../services/reports.js';
import { addSalesEntry, deleteSalesEntry, listSalesEntries } from '../services/sales.js';
import { getDb } from '../db/index.js';
import { toAgorot } from '../lib/money.js';
import { RuleError } from '../lib/errors.js';

const router = Router();

// Default the profitability range to the current calendar month.
function defaultRange() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const last = new Date(y, now.getMonth() + 1, 0).getDate();
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${String(last).padStart(2, '0')}` };
}

function storeList() {
  return getDb()
    .prepare(
      `SELECT st.id, st.name, c.name AS company_name
         FROM stores st JOIN companies c ON c.id = st.company_id ORDER BY c.name, st.name`,
    )
    .all();
}

function renderProfitability(req, res, extra = {}) {
  const def = defaultRange();
  const from = req.query.from || req.body?.from || def.from;
  const to = req.query.to || req.body?.to || def.to;
  const { stores, totals } = profitability(from, to);
  res.render('reports/profitability', {
    title: 'רווחיות',
    from,
    to,
    stores,
    totals,
    storeOptions: storeList(),
    salesEntries: listSalesEntries(30),
    error: null,
    notice: null,
    ...extra,
  });
}

// §7 "צ׳קים בחוץ"
router.get('/outstanding', (req, res) => {
  const { accounts, totalOutstanding } = outstandingChecks();
  const detailAccountId = req.query.account ? Number(req.query.account) : null;
  res.render('reports/outstanding', {
    title: 'צ׳קים בחוץ',
    accounts,
    totalOutstanding,
    detailAccountId,
    detailChecks: detailAccountId ? outstandingChecksForAccount(detailAccountId) : [],
  });
});

// §7 "בדיקת חשבונית"
router.get('/lookup', (req, res) => {
  const q = req.query.q || '';
  res.render('reports/lookup', {
    title: 'בדיקת חשבונית',
    query: q,
    results: q ? invoiceLookup(q) : [],
  });
});

// §7 "רווחיות"
router.get('/profitability', (req, res) => {
  renderProfitability(req, res);
});

// Add a register (Z) sales entry, then re-render the report.
router.post('/sales', (req, res, next) => {
  try {
    addSalesEntry(
      {
        storeId: Number(req.body.store_id),
        saleDate: req.body.sale_date,
        amount: toAgorot(req.body.amount),
        notes: req.body.notes || null,
      },
      req.user,
    );
    renderProfitability(req, res, { notice: 'רשומת מכירות נוספה.' });
  } catch (err) {
    if (err instanceof RuleError) return renderProfitability(req, res, { error: err.message });
    next(err);
  }
});

router.post('/sales/:id/delete', (req, res, next) => {
  try {
    deleteSalesEntry(Number(req.params.id), req.user);
    renderProfitability(req, res, { notice: 'רשומת מכירות נמחקה.' });
  } catch (err) {
    next(err);
  }
});

export default router;
