import { Router } from 'express';
import {
  createDraft,
  processDraft,
  getDraft,
  saveDraftEdits,
  approveDraft,
  deleteDraft,
  listPending,
  resetForReprocess,
} from '../services/scan.js';
import { listSuppliers, createSupplier } from '../services/suppliers.js';
import { matchSupplier } from '../lib/supplierMatch.js';
import { canViewPage } from '../lib/permissions.js';
import { readiness } from '../services/supplierProfile.js';
import { getExecutor } from '../db/adapter.js';
import { config } from '../config.js';
import { scopeClause } from '../lib/scope.js';
import { toAgorot } from '../lib/money.js';
import { getObject, del as removeStored } from '../lib/storage.js';
import { RuleError, AuthError } from '../lib/errors.js';
import { handleScanImages } from '../middleware/upload.js';
import { scopeParam } from '../lib/scopeGuard.js';

// צילום חשבוניות (stage 5) — the screens behind the mobile capture flow:
//   /scan            צילום ובחירת קבצים → העלאה
//   /scan/:id        מסך עיבוד (spinner+poll) / בדיקה ואישור / כישלון
//   /scan/pending    טיוטות שממתינות לאישור
// Every route here is already gated by requirePageAccess('nav_scan') at the mount point
// (src/app.js); the per-id company separation is the router.param guard below.

const router = Router();

// Company-separation guard: a draft of another company is refused with 404 on every /scan/:id path.
router.param('id', scopeParam('scanDraft'));

/** Stores the caller may file an invoice for (same query the invoice form uses). */
async function storesInScope(scope = null) {
  const sc = scopeClause(scope, 'c.id');
  return getExecutor().many(
    `SELECT st.id, st.name, c.name AS company_name
       FROM stores st JOIN companies c ON c.id = st.company_id
      WHERE 1 = 1${sc.sql} ORDER BY c.name, st.name`,
    [...sc.params],
  );
}

/**
 * Parse the review form into the `edits` object saveDraftEdits/approveDraft consume:
 * `{ header: {...}, lines: [...] }` with ALL money already in integer agorot.
 * Line inputs are array-style (`line_name[]` …), parsed positionally like the Z-expense rows;
 * a row whose name is empty is dropped (that is how the UI deletes a line).
 */
export function parseEdits(b) {
  const money = (v) => {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    try {
      return toAgorot(v);
    } catch (err) {
      // A typo in a money field is a form problem, not a crash — same treatment as a rule break.
      throw new RuleError('VALIDATION', err.message);
    }
  };
  const text = (v) => {
    const t = (v === undefined || v === null ? '' : String(v)).trim();
    return t === '' ? null : t;
  };

  const header = {
    supplierId: b.supplier_id ? Number(b.supplier_id) : null,
    invoiceNumber: text(b.invoice_number),
    allocationNumber: text(b.allocation_number),
    invoiceDate: text(b.invoice_date),
    docType: text(b.doc_type) || 'tax_invoice',
    amountBeforeVat: money(b.amount_before_vat),
    vatAmount: money(b.vat_amount),
    totalAmount: money(b.total_incl),
  };

  const names = [].concat(b.line_name || []);
  const barcodes = [].concat(b.line_barcode || []);
  const skus = [].concat(b.line_sku || []);
  const qtys = [].concat(b.line_qty || []);
  const unitQtys = [].concat(b.line_unit_qty || []);
  const unitCosts = [].concat(b.line_unit_cost || []);
  const totals = [].concat(b.line_total || []);
  const numOrNull = (v) => {
    if (v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const lines = [];
  names.forEach((rawName, i) => {
    const name = text(rawName);
    if (!name) return; // שורה ריקה / שנמחקה
    lines.push({
      lineNo: lines.length + 1,
      name,
      barcode: text(barcodes[i]),
      sku: text(skus[i]),
      quantity: numOrNull(qtys[i]),
      unitQuantity: numOrNull(unitQtys[i]),
      unitCost: money(unitCosts[i]),
      // A hand-typed cost is authoritative; an empty cell lets the validator recompute it.
      unitCostSource: money(unitCosts[i]) === null ? null : 'extracted',
      lineTotal: money(totals[i]),
      confidence: 'medium',
      flags: [],
    });
  });

  return { header, lines };
}

/** Everything show.ejs needs for the review form. */
async function reviewContext(req, draft, extra = {}) {
  return {
    title: 'בדיקת חשבונית שצולמה',
    draft,
    suppliers: await listSuppliers(),
    stores: await storesInScope(req.scope.companyIds),
    aiEnabled: config.ai.enabled,
    // Creating a supplier from the review screen needs the suppliers-page permission —
    // a scan-only employee sees the extracted details read-only instead.
    canCreateSupplier: canViewPage(req.user, 'nav_suppliers'),
    supValues: null, // re-fill values for the new-supplier panel after a refused create
    notice: null,
    error: null,
    confirmWarnings: null,
    ...extra,
  };
}

// ---- capture ------------------------------------------------------------------

router.get('/', async (req, res, next) => {
  try {
    // Suppliers are offered so the employee can name one BEFORE shooting: that is what lets the
    // supplier's learned profile ("הסקיל") travel with the first extraction instead of a re-run.
    const suppliers = await listSuppliers();
    res.render('scan/capture', {
      title: 'צילום חשבונית',
      stores: await storesInScope(req.scope.companyIds),
      suppliers: suppliers.map((sp) => ({ id: sp.id, name: sp.name, ready: readiness(sp.scan_profile).state })),
      aiEnabled: config.ai.enabled,
      maxPages: config.ai.maxScanImages,
      // The client encodes with exactly these values so the browser and the server can never
      // disagree about what was sent to the model (see config.ai.scanMaxEdge for the cost math).
      maxEdge: config.ai.scanMaxEdge,
      jpegQuality: config.ai.scanJpegQuality,
      maxUploadMb: Math.round(config.maxUploadBytes / (1024 * 1024)),
      error: null,
    });
  } catch (err) {
    next(err);
  }
});

// The capture page uploads via fetch() — answers are JSON, never a rendered page.
router.post('/upload', handleScanImages, async (req, res, next) => {
  try {
    if (req.uploadError) return res.status(400).json({ error: req.uploadError });
    const refs = req.uploadedRefs || [];
    if (refs.length === 0) return res.status(400).json({ error: 'לא נבחרו צילומים' });
    const storeId = Number(req.body.store_id);
    if (!storeId) return res.status(400).json({ error: 'יש לבחור חנות' });
    // Company separation on the way IN: a posted store_id outside the caller's scope is refused
    // (the picker only offers authorized stores, but the request can be forged).
    const allowed = await storesInScope(req.scope.companyIds);
    if (!allowed.some((s) => Number(s.id) === storeId)) {
      for (const ref of refs) await removeStored(ref); // no orphan blobs
      return res.status(403).json({ error: 'אין הרשאה לחנות שנבחרה' });
    }
    const supplierId = Number(req.body.supplier_id) || null;
    const draft = await createDraft({ storeId, imageRefs: refs, supplierId }, req.user);
    return res.json({ id: draft.id });
  } catch (err) {
    if (err instanceof RuleError) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.get('/pending', async (req, res, next) => {
  try {
    res.render('scan/pending', {
      title: 'סריקות ממתינות',
      drafts: await listPending(req.scope),
    });
  } catch (err) {
    next(err);
  }
});

// ---- one draft ----------------------------------------------------------------

router.get('/:id', async (req, res, next) => {
  try {
    const draft = await getDraft(Number(req.params.id));
    if (draft.status === 'committed' && draft.invoice_id) {
      return res.redirect(303, `/invoices/${draft.invoice_id}`);
    }
    let notice = null;
    if (req.query.saved === '1') notice = 'הטיוטה נשמרה.';
    if (req.query.supplier_created) {
      notice = `הספק "${req.query.supplier_created}" הוקם (ממתין לאישור בעלים) ושויך לחשבונית.`;
    }
    res.render('scan/show', await reviewContext(req, draft, { notice }));
  } catch (err) {
    next(err);
  }
});

// Run the extraction. Answers JSON so the processing screen can poll; 409 while another
// request is already working on this draft (the page simply keeps polling).
router.post('/:id/process', async (req, res, next) => {
  try {
    if (!config.ai.enabled) {
      return res.status(503).json({ status: 'failed', error: 'חילוץ אוטומטי אינו מוגדר — חסר מפתח API' });
    }
    const draft = await processDraft(Number(req.params.id), req.user);
    return res.json({ status: draft.status, error: draft.error || null });
  } catch (err) {
    if (err instanceof RuleError && err.rule === 'BUSY') {
      return res.status(409).json({ status: 'processing' });
    }
    if (err instanceof RuleError) {
      return res.status(400).json({ status: 'failed', error: err.message });
    }
    next(err);
  }
});

// Cheap poll target for the processing screen.
router.get('/:id/status.json', async (req, res, next) => {
  try {
    const row = await getExecutor().one('SELECT status, error FROM invoice_drafts WHERE id = ?', [
      Number(req.params.id),
    ]);
    if (!row) return res.status(404).json({ error: 'לא נמצא' });
    return res.json({ status: row.status, error: row.error || null });
  } catch (err) {
    next(err);
  }
});

// Serve one photographed page (auth-gated + company-scoped, same pattern as /invoices/:id/image).
router.get('/:id/image/:idx', async (req, res, next) => {
  const id = Number(req.params.id);
  const idx = Number(req.params.idx);
  try {
    const draft = await getDraft(id);
    const ref = draft.images[idx];
    if (!ref) {
      // Name the miss: "no image" with 2 pages stored means a wrong index, not a lost file.
      // eslint-disable-next-line no-console
      console.error('[scan] page image missing', { draft: id, page: idx, pages: draft.images.length });
      return res.status(404).send('אין תמונה');
    }
    const { buffer, contentType } = await getObject(ref);
    return res.type(contentType).send(buffer);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[scan] page image failed', { draft: id, page: idx, error: err.message });
    next(err);
  }
});

router.post('/:id/save', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    await saveDraftEdits(id, parseEdits(req.body), req.user);
    return res.redirect(303, `/scan/${id}?saved=1`);
  } catch (err) {
    if (err instanceof RuleError) return renderReview(req, res, id, err.message).catch(next);
    next(err);
  }
});

// Approve → invoice + lines + catalog. createInvoice's rules apply untouched: a WARN comes back
// as needsConfirmation and the form is re-rendered with the confirm checkbox (like invoices/new).
router.post('/:id/approve', async (req, res, next) => {
  const id = Number(req.params.id);
  const b = req.body;
  let edits = null; // stays null when the form itself could not be parsed
  try {
    edits = parseEdits(b);
    const { invoiceId, attached } = await approveDraft(
      id,
      { edits, confirm: b.confirm === '1', confirmReason: b.confirm_reason || null },
      req.user,
    );
    // `attached` means the scan completed an invoice that was already on file rather than
    // creating one, and the invoice screen says so instead of "נקלטה חשבונית חדשה".
    return res.redirect(303, `/invoices/${invoiceId}?scanned=${attached ? 'attached' : '1'}`);
  } catch (err) {
    // The approve transaction rolled back, so the draft is untouched — persist what the human
    // typed before re-rendering, or their corrections would be lost on the confirmation round.
    if (err instanceof RuleError && err.meta?.needsConfirmation) {
      return renderReview(req, res, id, null, err.meta.warnings, edits).catch(next);
    }
    if (err instanceof RuleError) return renderReview(req, res, id, err.message, null, edits).catch(next);
    next(err);
  }
});

// Create a supplier straight from the review screen, prefilled with what the model read.
// Reachable by every nav_scan user (the page firewall allows /scan/*), so the suppliers-page
// permission is enforced explicitly here.
router.post('/:id/supplier', async (req, res, next) => {
  const id = Number(req.params.id);
  const b = req.body;
  let edits = null;
  try {
    if (!canViewPage(req.user, 'nav_suppliers')) {
      throw new AuthError('הקמת ספק ממסך הסריקה — נדרשת הרשאת עמוד ספקים');
    }
    edits = parseEdits(b); // the whole review form posts along — the draft survives the round trip
    const name = (b.sup_name || '').trim();
    if (!name) {
      return renderReview(req, res, id, 'שם ספק חובה להקמת ספק חדש', null, edits, {
        supValues: b,
      });
    }
    // Duplicate guard: the same matcher the extraction uses. A tick on the panel's
    // "אשר יצירה בכל זאת" checkbox overrides.
    if (b.supplier_confirm !== '1') {
      const dup = matchSupplier(name, b.sup_tax_id, await listSuppliers());
      if (dup) {
        return renderReview(
          req,
          res,
          id,
          `השם דומה לספק קיים "${dup.supplier.name}" — אם זהו ספק אחר, סמנו "אשר יצירה בכל זאת" ושלחו שוב.`,
          null,
          edits,
          { supValues: b },
        );
      }
    }
    const supplier = await createSupplier(
      {
        name,
        taxId: b.sup_tax_id,
        phone: b.sup_phone,
        email: b.sup_email,
        contactName: b.sup_contact_name,
        contactPhone: b.sup_contact_phone,
        notes: (b.sup_notes || '').trim() || 'נוצר מסריקת חשבונית',
      },
      req.user,
    );
    edits.header.supplierId = supplier.id;
    await saveDraftEdits(id, edits, req.user);
    return res.redirect(303, `/scan/${id}?supplier_created=${encodeURIComponent(supplier.name)}`);
  } catch (err) {
    if (err instanceof RuleError) {
      return renderReview(req, res, id, err.message, null, edits, { supValues: b }).catch(next);
    }
    next(err);
  }
});

// Re-run the extraction on the stored photos (after logic improvements / a bad first pass).
// Resets the draft to `uploaded` and redirects to the processing screen, which fires
// POST /:id/process and polls — the same flow as a fresh upload.
router.post('/:id/reprocess', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    if (!config.ai.enabled) {
      return renderReview(req, res, id, 'חילוץ אוטומטי אינו מוגדר — חסר מפתח API').catch(next);
    }
    await resetForReprocess(id, req.user);
    return res.redirect(303, `/scan/${id}`);
  } catch (err) {
    if (err instanceof RuleError) return renderReview(req, res, id, err.message).catch(next);
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await deleteDraft(Number(req.params.id), req.user);
    return res.redirect(303, '/scan/pending');
  } catch (err) {
    if (err instanceof RuleError) {
      return renderReview(req, res, Number(req.params.id), err.message).catch(next);
    }
    next(err);
  }
});

/**
 * Re-render the review screen after a refused approve/save. `edits` (when given) are saved to
 * the draft first — best-effort — so the screen comes back with the human's own values.
 */
async function renderReview(req, res, id, error, confirmWarnings = null, edits = null, extra = {}) {
  if (edits) {
    try {
      await saveDraftEdits(id, edits, req.user);
    } catch {
      /* לא הצלחנו לשמור את העריכה — מציגים את הטיוטה כפי שהיא */
    }
  }
  const draft = await getDraft(id);
  res.status(error ? 400 : 200).render(
    'scan/show',
    await reviewContext(req, draft, {
      title: confirmWarnings ? 'בדיקת חשבונית — אישור אזהרות' : 'בדיקת חשבונית שצולמה',
      error,
      confirmWarnings,
      ...extra,
    }),
  );
}

export default router;
