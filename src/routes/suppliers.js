import { Router } from 'express';
import { parseProfile, readiness, hintsFor, setHints } from '../services/supplierProfile.js';
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
import { scopedStoreList, assignmentScope } from '../lib/scope.js';
import { RuleError, AuthError } from '../lib/errors.js';
import { assertStoreAllowed } from '../lib/scopeGuard.js';

const router = Router();

// Stores available to assign to a supplier (all stores, grouped visually by company in the view).
// Scoped — see lib/scope.js#scopedStoreList. A supplier can only be tied to stores the caller
// may access; listing every store here also leaked the whole org chart into a checkbox group.
const storeOptions = (req) => scopedStoreList(assignmentScope(req));

// Selected store ids from the supplier form (checkbox group `store_ids`).
// Every posted store id must be one the caller may access — otherwise a user granted store A
// could link a supplier to store B (and, through it, see B's data) by editing the checkbox list.
async function assertStoreIdsAllowed(ids, scope) {
  for (const id of ids) await assertStoreAllowed(id, scope);
  return ids;
}

function storeIdsFrom(body) {
  return [].concat(body.store_ids || []).map(Number).filter(Boolean);
}

async function renderList(req, res, extra = {}) {
  res.render('suppliers/index', {
    title: 'ספקים',
    suppliers: await listSuppliers(null, undefined, { scope: req.scope }),
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
      suppliers: await listSuppliers(req.query.status || null, undefined, { scope: req.scope }),
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
      suppliers: q ? await searchSuppliers(q, req.scope) : await listSuppliers(null, undefined, { scope: req.scope }),
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
    res.render('suppliers/new', { title: 'ספק חדש', values: req.query || {}, error: null, stores: await storeOptions(req), selectedStores: [] });
  } catch (err) {
    next(err);
  }
});

// Payment fields from the form: method code + terms, where "other" swaps in the free-text value.
function paymentFields(body) {
  const terms = body.payment_terms === 'other' ? (body.payment_terms_other || '').trim() : (body.payment_terms || '').trim();
  return {
    paymentMethod: (body.payment_method || '').trim() || null,
    paymentTerms: terms || null,
    // "עסקאות בשיעור אפס" — fresh produce (§30(א)(13)). It does NOT bypass R3, which is always
    // computed from the VAT actually on the invoice; it only silences the review-time
    // "big tax invoice with no VAT — was it forgotten?" check for this supplier.
    zeroRated: !!body.zero_rated,
  };
}

router.post('/', async (req, res, next) => {
  try {
    const supplier = await createSupplier(
      {
        name: req.body.name, taxId: req.body.tax_id, notes: req.body.notes,
        phone: req.body.phone, email: req.body.email,
        contactName: req.body.contact_name, contactPhone: req.body.contact_phone,
        storeIds: await assertStoreIdsAllowed(storeIdsFrom(req.body), assignmentScope(req)),
        ...paymentFields(req.body),
      },
      req.user,
    );
    res.redirect(303, `/suppliers?created=${supplier.id}`);
  } catch (err) {
    if (err instanceof RuleError) {
      return res.status(400).render('suppliers/new', { title: 'ספק חדש', values: req.body, error: err.message, stores: await storeOptions(req), selectedStores: storeIdsFrom(req.body) });
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
      return renderList(req, res, { error: 'בחר פעולה ולפחות ספק אחד.' });
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
    return renderList(req, res, {
      notice: `${ok} ספקים ${label}.`,
      error: failures.length ? failures.join(' · ') : null,
    });
  } catch (err) {
    next(err);
  }
});

// Edit a supplier's full details.
// "הסקיל של הספק" — the owner's own notes on how to read this supplier's invoices. The learned
// parts (layout, repeated corrections) are written by the scanner and are not editable here; this
// only replaces the free-text lines, so a human can teach the system something it has not seen yet
// and can delete a rule that turned out wrong.
router.post('/:id/scan-hints', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const lines = String(req.body.hints || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 12); // a profile is a short briefing, not a manual
    await setHints(id, lines);
    return res.redirect(303, `/suppliers/${id}/edit?saved=skill`);
  } catch (err) {
    next(err);
  }
});

router.get('/:id/edit', async (req, res, next) => {
  try {
    const supplier = await getSupplier(Number(req.params.id));
    const profile = parseProfile(supplier.scan_profile);
    res.render('suppliers/edit', {
      title: `עריכת ספק — ${supplier.name}`,
      supplier,
      error: null,
      stores: await storeOptions(req),
      selectedStores: await getSupplierStoreIds(supplier.id),
      // Parent-supplier options for the "חברת-אם (לתשלום מרוכז)" picker: top-level suppliers only
      // (a subsidiary can't itself be a parent), excluding this supplier.
      parentOptions: (await listSuppliers(null, undefined, { scope: req.scope })).filter((s) => s.id !== supplier.id && s.parent_supplier_id == null),
      notice: req.query.saved === 'skill' ? 'הסקיל של הספק עודכן.' : null,
      // "הסקיל": what scanning this supplier's invoices has taught the system so far.
      profile,
      readiness: readiness(profile),
      profileHints: hintsFor(profile),
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
      storeIds: await assertStoreIdsAllowed(storeIdsFrom(req.body), assignmentScope(req)),
      parentSupplierId: req.body.parent_supplier_id ? Number(req.body.parent_supplier_id) : null,
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
        stores: await storeOptions(req),
        selectedStores: await getSupplierStoreIds(id),
      });
    }
    await updateSupplier(id, fields, req.user);
    res.redirect(303, '/suppliers');
  } catch (err) {
    if (err instanceof RuleError) {
      const supplier = { ...req.body, id: Number(req.params.id), tax_id: req.body.tax_id, contact_name: req.body.contact_name, contact_phone: req.body.contact_phone, parent_supplier_id: req.body.parent_supplier_id ? Number(req.body.parent_supplier_id) : null };
      return res.status(400).render('suppliers/edit', { title: 'עריכת ספק', supplier, error: err.message, stores: await storeOptions(req), selectedStores: storeIdsFrom(req.body), parentOptions: (await listSuppliers(null, undefined, { scope: req.scope })).filter((s) => s.id !== Number(req.params.id) && s.parent_supplier_id == null) });
    }
    next(err);
  }
});

// Same-site relative redirect only (e.g. back to /approvals when approved from there).
function safeReturn(req, fallback) {
  const r = (req.body.return_to || '').toString();
  return r.startsWith('/') && !r.startsWith('//') ? r : fallback;
}

router.post('/:id/approve', async (req, res, next) => {
  try {
    await approveSupplier(Number(req.params.id), req.user);
    res.redirect(303, safeReturn(req, '/suppliers?status=pending'));
  } catch (err) {
    if (err instanceof AuthError) return renderList(req, res, { error: err.message });
    next(err);
  }
});

router.post('/:id/block', async (req, res, next) => {
  try {
    await blockSupplier(Number(req.params.id), req.user, req.body.reason || null);
    res.redirect(303, safeReturn(req, '/suppliers'));
  } catch (err) {
    if (err instanceof AuthError) return renderList(req, res, { error: err.message });
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await deleteSupplier(Number(req.params.id), req.user);
    res.redirect(303, '/suppliers');
  } catch (err) {
    if (err instanceof AuthError || err instanceof RuleError) return renderList(req, res, { error: err.message });
    next(err);
  }
});

export default router;
