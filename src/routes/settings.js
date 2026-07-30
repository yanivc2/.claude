import { Router } from 'express';
import {
  listStructure,
  createCompany,
  updateCompany,
  createStoreWithAccount,
  updateAccountDisplayName,
} from '../services/orgs.js';
import { requireOwner } from '../middleware/requireOwner.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

// Everything here is owner-only (structural configuration).
router.use(requireOwner);

function render(req, res, extra = {}) {
  res.render('settings/index', {
    title: 'הגדרות — חנויות וחשבונות',
    companies: listStructure(),
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', (req, res) => render(req, res));

router.post('/companies', (req, res, next) => {
  try {
    createCompany({ name: req.body.name, companyType: req.body.company_type, taxId: req.body.tax_id }, req.user);
    render(req, res, { notice: 'חברה נוספה.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/companies/:id', (req, res, next) => {
  try {
    updateCompany(Number(req.params.id), { name: req.body.name, taxId: req.body.tax_id }, req.user);
    render(req, res, { notice: 'פרטי החברה עודכנו.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/stores', (req, res, next) => {
  try {
    createStoreWithAccount(
      {
        companyId: Number(req.body.company_id),
        storeName: req.body.store_name,
        address: req.body.address,
        bankName: req.body.bank_name,
        branch: req.body.branch,
        accountNumber: req.body.account_number,
        displayName: req.body.display_name,
      },
      req.user,
    );
    render(req, res, { notice: 'חנות וחשבון בנק נוספו.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

router.post('/accounts/:id', (req, res, next) => {
  try {
    updateAccountDisplayName(Number(req.params.id), req.body.display_name, req.user);
    render(req, res, { notice: 'שם התצוגה של החשבון עודכן.' });
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return render(req, res, { error: err.message });
    next(err);
  }
});

export default router;
