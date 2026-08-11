import { Router } from 'express';
import {
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  updateSupplierContacts,
  searchSuppliers,
  approveSupplier,
  blockSupplier,
  deleteSupplier,
  getSupplierStoreIds,
} from '../services/suppliers.js';
import { submitRequest } from '../services/changeRequests.js';
import { describeSupplier } from '../lib/changeSummary.js';
import { getExecutor } from '../db/adapter.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

// Stores available to assign to a supplier (all stores, grouped visually by company in the view).
async function storeOptions() {
  return getExecutor().many(
    `SELECT st.id, st.name, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id
      ORDER BY c.name, st.name`,
    [],
  );
}

// Selected store ids from the supplier form (checkbox group `store_ids`).
function storeIdsFrom(body) {
  return [].concat(body.store_ids || []).map(Number).filter(Boolean);
}

async function renderList(res, extra = {}) {
  res.render('suppliers/index', {
    title: 'ספקים',
    suppliers: await listSuppliers(null),
    filter: '',
    error: null,
    notice: null,
    ...extra,
  });
}

router.get('/', async (req, res, next) => {
  try {
    res.render('suppliers/index', {
      title: 'ספקים',
      suppliers: await listSuppliers(req.query.status || null),
      filter: req.query.status || '',
      error: null,
      notice: null,
    });
  } catch (err) {
    next(err);
  }
});

// "אנשי קשר ספקים" tab.
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
      { phone: req.body.phone, email: req.body.email, contactName: req.body.contact_name, contactPhone: req.body.contact_phone },
      req.user,
    );
    res.redirect(303, '/suppliers/contacts?saved=' + req.params.id);
  } catch (err) {
    next(err);
  }
});

// Query params prefill the form (e.g. /suppliers/new?name=…&tax_id=… from the scan screen).
router.get('/new', async (req, res, next) => {
  try {
    res.render('suppliers/new', { title: 'ספק חדש', values: req.query || {}, error: null, stores: await storeOptions(), selectedStores: [] });
  } catch (err) {
    next(err);
  }
});

// Payment fields from the form: method code + terms, where "other" swaps in the free-text value.
function paymentFields(body) {
  const terms = body.payment_terms === 'other' ? (body.payment_terms_other || '').trim() : (body.payment_terms || '').trim();
  return { paymentMethod: (body.payment_method || '').trim() || null, paymentTerms: terms || null };
}

router.post('/', async (req, res, next) => {
  try {
    const supplier = await createSupplier(
      {
        name: req.body.name, taxId: req.body.tax_id, notes: req.body.notes,
        phone: req.body.phone, email: req.body.email,
        contactName: req.body.contact_name, contactPhone: req.body.contact_phone,
        storeIds: storeIdsFrom(req.body),
        ...paymentFields(req.body),
      },
      req.user,
    );
    res.redirect(303, `/suppliers?created=${supplier.id}`);
  } catch (err) {
    if (err instanceof RuleError) {
      return res.status(400).render('suppliers/new', { title: 'ספק חדש', values: req.body, error: err.message, stores: await storeOptions(), selectedStores: storeIdsFrom(req.body) });
    }
    next(err);
  }
});

// Bulk action on selected suppliers: approve / block / delete.
router.post('/bulk', async (req, res, next) => {
  try {
    const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean);
    const action = req.body.bulk_action;
    if (!ids.length || !['approve', 'block', 'delete'].includes(action)) {
      return renderList(res, { error: 'בחר פעולה ולפחות ספק אחד.' });
    }
    let ok = 0;
    const failures = [];
    for (const id of ids) {
      try {
        if (action === 'approve') await approveSupplier(id, req.user);
        else if (action === 'block') await blockSupplier(id, req.user, null);
        else await deleteSupplier(id, req.user);
        ok += 1;
      } catch (e) {
        failures.push(`#${id}: ${e.message}`);
      }
    }
    const label = { approve: 'אושרו', block: 'נחסמו', delete: 'נמחקו' }[action];
    return renderList(res, {
      notice: `${ok} ספקים ${label}.`,
      error: failures.length ? failures.join(' · ') : null,
    });
  } catch (err) {
    next(err);
  }
});

// Edit a supplier's full details.
router.get('/:id/edit', async (req, res, next) => {
  try {
    const supplier = await getSupplier(Number(req.params.id));
    res.render('suppliers/edit', {
      title: `עריכת ספק — ${supplier.name}`,
      supplier,
      error: null,
      stores: await storeOptions(),
      selectedStores: await getSupplierStoreIds(supplier.id),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/edit', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const fields = {
      name: req.body.name, taxId: req.body.tax_id, notes: req.body.notes,
      phone: req.body.phone, email: req.body.email,
      contactName: req.body.contact_name, contactPhone: req.body.contact_phone,
      storeIds: storeIdsFrom(req.body),
      ...paymentFields(req.body),
    };
    // Non-owners: queue the field edit for approval (store assignment is not part of the queued
    // payload — it's low-risk metadata handled by the owner/manager directly).
    if (req.user.role !== 'owner') {
      const current = await getSupplier(id);
      await submitRequest(
        { action: 'supplier.update', entityType: 'supplier', entityId: id, payload: { id, fields }, summary: describeSupplier(current, fields) },
        req.user,
      );
      return res.render('suppliers/edit', {
        title: `עריכת ספק — ${current.name}`,
        supplier: current,
        error: null,
        notice: 'בקשת העריכה נשלחה לאישור הבעלים. השינוי יבוצע לאחר אישור.',
        stores: await storeOptions(),
        selectedStores: await getSupplierStoreIds(id),
      });
    }
    await updateSupplier(id, fields, req.user);
    res.redirect(303, '/suppliers');
  } catch (err) {
    if (err instanceof RuleError) {
      const supplier = { ...req.body, id: Number(req.params.id), tax_id: req.body.tax_id, contact_name: req.body.contact_name, contact_phone: req.body.contact_phone };
      return res.status(400).render('suppliers/edit', { title: 'עריכת ספק', supplier, error: err.message, stores: await storeOptions(), selectedStores: storeIdsFrom(req.body) });
    }
    next(err);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    await approveSupplier(Number(req.params.id), req.user);
    res.redirect(303, '/suppliers?status=pending');
  } catch (err) {
    if (err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

router.post('/:id/block', async (req, res, next) => {
  try {
    await blockSupplier(Number(req.params.id), req.user, req.body.reason || null);
    res.redirect(303, '/suppliers');
  } catch (err) {
    if (err instanceof AuthError) return renderList(res, { error: err.message });
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await deleteSupplier(Number(req.params.id), req.user);
    res.redirect(303, '/suppliers');
  } catch (err) {
    if (err instanceof AuthError || err instanceof RuleError) return renderList(res, { error: err.message });
    next(err);
  }
});

export default router;
