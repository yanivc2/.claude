import { Router } from 'express';
import {
  outstandingChecks,
  outstandingChecksForAccount,
  invoiceLookup,
} from '../services/reports.js';

const router = Router();

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

export default router;
