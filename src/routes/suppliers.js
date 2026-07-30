import { Router } from 'express';
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  approveSupplier,
  blockSupplier,
} from '../services/suppliers.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

router.get('/', (req, res) => {
  res.render('suppliers/index', {
    title: 'ספקים',
    suppliers: listSuppliers(req.query.status || null),
    filter: req.query.status || '',
  });
});

router.get('/new', (req, res) => {
  res.render('suppliers/new', { title: 'ספק חדש', values: {}, error: null });
});

router.post('/', (req, res, next) => {
  try {
    const supplier = createSupplier(
      { name: req.body.name, taxId: req.body.tax_id, notes: req.body.notes },
      req.user,
    );
    res.redirect(`/suppliers?status=&created=${supplier.id}`);
  } catch (err) {
    if (err instanceof RuleError) {
      return res
        .status(400)
        .render('suppliers/new', { title: 'ספק חדש', values: req.body, error: err.message });
    }
    next(err);
  }
});

router.post('/:id/approve', (req, res, next) => {
  try {
    approveSupplier(Number(req.params.id), req.user);
    res.redirect('/suppliers?status=pending');
  } catch (err) {
    if (err instanceof AuthError) return renderList(res, err.message);
    next(err);
  }
});

router.post('/:id/block', (req, res, next) => {
  try {
    blockSupplier(Number(req.params.id), req.user, req.body.reason || null);
    res.redirect('/suppliers');
  } catch (err) {
    if (err instanceof AuthError) return renderList(res, err.message);
    next(err);
  }
});

function renderList(res, error) {
  res.status(403).render('suppliers/index', {
    title: 'ספקים',
    suppliers: listSuppliers(null),
    filter: '',
    error,
  });
}

export default router;
