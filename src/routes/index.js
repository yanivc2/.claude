import { Router } from 'express';
import { dashboardStats, invoiceLookup } from '../services/reports.js';
import { lookupChecks } from '../services/payments.js';
import { listRecent } from '../services/audit.js';
import { getDb } from '../db/index.js';

const router = Router();

router.get('/', (req, res) => {
  const q = (req.query.q || '').trim();
  const companyId = req.query.company ? Number(req.query.company) : null;
  const storeId = req.query.store ? Number(req.query.store) : null;
  const db = getDb();
  res.render('dashboard', {
    title: 'לוח בקרה',
    stats: dashboardStats(),
    q,
    companyId,
    storeId,
    companies: db.prepare('SELECT id, name FROM companies ORDER BY name').all(),
    stores: db
      .prepare('SELECT id, name, company_id FROM stores ORDER BY name')
      .all(),
    invoiceResults: q ? invoiceLookup(q, { companyId, storeId }) : null,
    checkResults: q ? lookupChecks(q) : null,
  });
});

router.get('/audit', (req, res) => {
  res.render('audit', { title: 'יומן ביקורת', entries: listRecent(200) });
});

// Stage-1 role switch (not a security boundary — see README / currentUser middleware).
router.post('/switch-user', (req, res) => {
  const uid = Number(req.body.uid);
  if (Number.isInteger(uid)) {
    res.cookie('uid', String(uid), { httpOnly: true, sameSite: 'lax' });
  }
  res.redirect(req.get('referer') || '/');
});

export default router;
