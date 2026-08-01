import { Router } from 'express';
import {
  listSuppliers,
  createSupplier,
  updateSupplierContacts,
  searchSuppliers,
  approveSupplier,
  blockSupplier,
} from '../services/suppliers.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.render('suppliers/index', {
      title: 'ספקים',
      suppliers: await listSuppliers(req.query.status || null),
      filter: req.query.status || '',
    });
  } catch (err) {
    next(err);
  }
});

// "אנשי קשר ספקים" tab — searchable list with contact details, inline-editable.
router.get('/contacts', async (req, res, next) => {
  try {
    const q = req.query.q || '';
    res.render('suppliers/contacts', {
      title: 'אנשי קשר ספקים',
      suppliers: q ? await searchSuppliers(q) : await listSuppliers(),
      q,
      notice: null,
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/contacts', async (req, res, next) => {
  try {
    await updateSupplierContacts(
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

router.post('/', async (req, res, next) => {
  try {
    const supplier = await createSupplier(
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

router.post('/:id/approve', async (req, res, next) => {
  try {
    await approveSupplier(Number(req.params.id), req.user);
    res.redirect('/suppliers?status=pending');
  } catch (err) {
    if (err instanceof AuthError) return renderList(res, err.message);
    next(err);
  }
});

router.post('/:id/block', async (req, res, next) => {
  try {
    await blockSupplier(Number(req.params.id), req.user, req.body.reason || null);
    res.redirect('/suppliers');
  } catch (err) {
    if (err instanceof AuthError) return renderList(res, err.message);
    next(err);
  }
});

async function renderList(res, error) {
  res.status(403).render('suppliers/index', {
    title: 'ספקים',
    suppliers: await listSuppliers(null),
    filter: '',
    error,
  });
}

export default router;
