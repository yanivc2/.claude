import { Router } from 'express';
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplierContacts,
  searchSuppliers,
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

// "אנשי קשר ספקים" tab — searchable list with contact details, inline-editable.
router.get('/contacts', (req, res) => {
  const q = req.query.q || '';
  res.render('suppliers/contacts', {
    title: 'אנשי קשר ספקים',
    suppliers: q ? searchSuppliers(q) : listSuppliers(),
    q,
    notice: null,
    error: null,
  });
});

router.post('/:id/contacts', (req, res, next) => {
  try {
    updateSupplierContacts(
      Number(req.params.id),
      {
        phone: req.body.phone,
        email: req.body.email,
        contactName: req.body.contact_name,
        contactPhone: req.body.contact_phone,
      },
      req.user,
    );
    res.redirect('/suppliers/contacts?saved=' + req.params.id);
  } catch (err) {
    next(err);
  }
});

router.get('/new', (req, res) => {
  res.render('suppliers/new', { title: 'ספק חדש', values: {}, error: null });
});

router.post('/', (req, res, next) => {
  try {
    const supplier = createSupplier(
      {
        name: req.body.name,
        taxId: req.body.tax_id,
        notes: req.body.notes,
        phone: req.body.phone,
        email: req.body.email,
        contactName: req.body.contact_name,
        contactPhone: req.body.contact_phone,
      },
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
