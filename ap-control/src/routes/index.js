import { Router } from 'express';
import { dashboardStats, invoiceLookup } from '../services/reports.js';
import { lookupChecks } from '../services/payments.js';
import { searchSuppliers } from '../services/suppliers.js';
import { listRecent } from '../services/audit.js';
import { getExecutor } from '../db/adapter.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const companyId = req.query.company ? Number(req.query.company) : null;
    const storeId = req.query.store ? Number(req.query.store) : null;
    const x = getExecutor();
    res.render('dashboard', {
      title: 'לוח בקרה',
      stats: await dashboardStats(),
      q,
      companyId,
      storeId,
      companies: await x.many('SELECT id, name FROM companies ORDER BY name', []),
      stores: await x.many('SELECT id, name, company_id FROM stores ORDER BY name', []),
      invoiceResults: q ? await invoiceLookup(q, { companyId, storeId }) : null,
      checkResults: q ? await lookupChecks(q) : null,
      supplierResults: q ? await searchSuppliers(q) : null,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/audit', async (req, res, next) => {
  try {
    res.render('audit', { title: 'יומן ביקורת', entries: await listRecent(200) });
  } catch (err) {
    next(err);
  }
});

export default router;
