import { Router } from 'express';
import {
  listInvoices,
  getInvoiceDetail,
  getInvoice,
  createInvoice,
  updateInvoice,
  approveInvoiceForPayment,
  putOnHold,
  releaseHold,
  reconcileR3Hold,
  setAllocationNumber,
  setImage,
  clearImage,
  listPayable,
} from '../services/invoices.js';
import { listSuppliers } from '../services/suppliers.js';
import { cashPaymentsForInvoice } from '../services/zreports.js';
import { recentClosingExpenses } from '../services/zclosing.js';
import { runOcrForInvoice, compareToInvoice, getOcr, deleteOcr } from '../services/ocr.js';
import { createEvent } from '../services/calendar.js';
import { getExecutor } from '../db/adapter.js';
import { scopeClause } from '../lib/scope.js';
import { toAgorot, fromAgorot } from '../lib/money.js';
import { handleInvoiceImage } from '../middleware/upload.js';
import { getObject, del as removeStored } from '../lib/storage.js';
import { createPayment } from '../services/payments.js';
import { submitRequest, pendingRequestFor } from '../services/changeRequests.js';
import { userCan } from '../lib/permissions.js';
import { describeInvoice } from '../lib/changeSummary.js';
import { RuleError, AuthError } from '../lib/errors.js';
import { requirePermission } from '../middleware/requireOwner.js';
import { scopeParam, assertInScope } from '../lib/scopeGuard.js';

const router = Router();

// Company-separation guard: every /invoices/:id route (read AND write) is refused with 404
// when the invoice belongs to a company the caller isn't authorized for.
router.param('id', scopeParam('invoice'));

/** Best-effort delete of a stored upload by its ref (fire-and-forget; never throws). */
function removeUpload(ref) {
  if (ref) void removeStored(ref);
}

async function formData(scope = null) {
  const sc = scopeClause(scope, 'c.id');
  return {
    suppliers: await listSuppliers(),
    stores: await getExecutor().many(
      `SELECT st.id, st.name, c.name AS company_name
         FROM stores st JOIN companies c ON c.id = st.company_id
        WHERE 1 = 1${sc.sql} ORDER BY c.name, st.name`,
      [...sc.params],
    ),
  };
}

// Everything the invoice screen shows that came from a scan (stage 5): the stored line items
// and, when the invoice was created by approving a scanned draft, that draft's page images.
// Both are absent for a hand-entered invoice — the view simply skips those cards.
async function scanContext(invoiceId) {
  const x = getExecutor();
  const lines = await x.many(
    'SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no, id',
    [invoiceId],
  );
  const draft = await x.one(
    "SELECT id, images FROM invoice_drafts WHERE invoice_id = ? AND status = 'committed'",
    [invoiceId],
  );
  let scanPages = [];
  if (draft?.images) {
    try {
      scanPages = JSON.parse(draft.images) || [];
    } catch {
      scanPages = [];
    }
  }
  return { lines, scanPages };
}

// For the "save & add another" batch flow: the still-payable invoices already recorded
// for one supplier at one store, so they can be paid together from the new-invoice screen.
async function batchContext(supplierId, storeId) {
  const sid = Number(supplierId);
  const stid = Number(storeId);
  if (!sid || !stid) return { batchInvoices: [] };
  const payable = await listPayable();
  return { batchInvoices: payable.filter((i) => i.supplier_id === sid && i.store_id === stid) };
}

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const supplierId = req.query.supplier ? Number(req.query.supplier) : null;
    const storeId = req.query.store ? Number(req.query.store) : null;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : null;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : null;
    const { suppliers, stores } = await formData(req.scope.companyIds);
    res.render('invoices/index', {
      title: 'חשבוניות',
      invoices: await listInvoices({ status: req.query.status || null, scope: req.scope.companyIds, supplierId, storeId, q, from, to }),
      filter: req.query.status || '',
      q,
      supplierId,
      storeId,
      from,
      to,
      suppliers,
      stores,
      closingExpenses: await recentClosingExpenses(req.scope.companyIds, 30),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    const supplierId = req.query.supplier ? Number(req.query.supplier) : null;
    const storeId = req.query.store ? Number(req.query.store) : null;
    const ctx = await batchContext(supplierId, storeId);
    res.render('invoices/new', {
      title: 'חשבונית חדשה',
      ...(await formData(req.scope.companyIds)),
      values: supplierId ? { supplier_id: supplierId, store_id: storeId || '' } : {},
      warnings: [],
      error: null,
      notice: req.query.added ? 'החשבונית נשמרה. אפשר להזין עוד חשבונית לאותו הספק, או לשייך את הכל לתשלום למטה.' : null,
      ...ctx,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', handleInvoiceImage, async (req, res, next) => {
  const b = req.body;
  const carried = b.uploaded_image || null;
  const imagePath = req.file ? req.file.filename : carried;
  if (req.file && carried && carried !== req.file.filename) removeUpload(carried);

  const rerender = async (extra) => {
    res.render('invoices/new', {
      title: 'חשבונית חדשה',
      ...(await formData(req.scope.companyIds)),
      values: b,
      warnings: [],
      error: null,
      uploadedImage: imagePath,
      ...(await batchContext(b.supplier_id, b.store_id)),
      ...extra,
    });
  };

  if (req.uploadError) {
    if (imagePath) removeUpload(imagePath);
    return res.status(400).render('invoices/new', {
      title: 'חשבונית חדשה',
      ...(await formData(req.scope.companyIds)),
      values: b,
      warnings: [],
      error: req.uploadError,
      uploadedImage: null,
      ...(await batchContext(b.supplier_id, b.store_id)),
    });
  }

  try {
    const input = {
      supplierId: Number(b.supplier_id),
      storeId: Number(b.store_id),
      invoiceNumber: b.invoice_number,
      allocationNumber: b.allocation_number,
      invoiceDate: b.invoice_date,
      amountBeforeVat: toAgorot(b.amount_before_vat),
      vatAmount: toAgorot(b.vat_amount),
      docType: b.doc_type,
      imagePath,
      confirm: b.confirm === '1',
      confirmReason: b.confirm_reason || null,
    };
    const { invoice } = await createInvoice(input, req.user);
    // Optional: the invoice was paid — create the payment (check/transfer/cash) and link it.
    const method = (b.pay_method || '').trim();
    if (method) {
      try {
        const ba = await getExecutor().one('SELECT id FROM bank_accounts WHERE store_id = ?', [invoice.store_id]);
        const payInput = { bankAccountId: ba?.id, method, invoiceIds: [invoice.id] };
        if (method === 'check') {
          payInput.checkNumber = b.check_number;
          payInput.paymentDate = b.check_due_date || invoice.invoice_date;
        } else if (method === 'transfer') {
          payInput.reference = b.transfer_ref;
          payInput.paymentDate = b.transfer_date || invoice.invoice_date;
        } else if (method === 'cash') {
          payInput.payerName = b.cash_payer;
          payInput.paymentDate = b.cash_date || invoice.invoice_date;
        } else if (method === 'credit') {
          payInput.cardLast4 = b.card_last4;
          payInput.paymentDate = b.credit_date || invoice.invoice_date;
        } else if (method === 'standing_order') {
          payInput.reference = b.so_ref;
          payInput.paymentDate = b.so_date || invoice.invoice_date;
        }
        await createPayment(payInput, req.user);
        return res.redirect(303, `/invoices/${invoice.id}?paid=1`);
      } catch (payErr) {
        // The invoice is saved; only the payment failed (e.g. R3 hold / unapproved supplier / cash ceiling).
        return res.redirect(303, `/invoices/${invoice.id}?payfail=${encodeURIComponent(payErr.message || 'שגיאה')}`);
      }
    }
    // "שמור והוסף עוד לספק" — reopen the form for the same supplier/store to keep entering.
    if (b.action === 'add_another') {
      return res.redirect(303, `/invoices/new?supplier=${invoice.supplier_id}&store=${invoice.store_id}&added=1`);
    }
    return res.redirect(303, `/invoices/${invoice.id}`);
  } catch (err) {
    if (err instanceof RuleError && err.meta?.needsConfirmation) {
      return res.status(200).render('invoices/new', {
        title: 'חשבונית חדשה — אישור אזהרות',
        ...(await formData(req.scope.companyIds)),
        values: b,
        warnings: err.meta.warnings,
        error: null,
        uploadedImage: imagePath,
        ...(await batchContext(b.supplier_id, b.store_id)),
      });
    }
    if (err instanceof RuleError) {
      return rerender({ error: err.message });
    }
    if (req.file) removeUpload(req.file.filename);
    next(err);
  }
});

// Combined payment from the new-invoice screen: pay several recorded invoices of one
// supplier/store together (credit notes net out). Reuses createPayment (R1/R5 enforced).
router.post('/pay-batch', async (req, res, next) => {
  const b = req.body;
  const supplierId = Number(b.supplier_id);
  const storeId = Number(b.store_id);
  const invoiceIds = []
    .concat(b.invoice_ids || [])
    .map(Number)
    .filter(Boolean);
  try {
    if (invoiceIds.length === 0) throw new RuleError('R', 'לא נבחרו חשבוניות לתשלום');
    // Company separation: refuse if any selected invoice is outside the caller's scope.
    for (const invId of invoiceIds) await assertInScope('invoice', invId, req.scope.companyIds);
    const ba = await getExecutor().one('SELECT id FROM bank_accounts WHERE store_id = ?', [storeId]);
    const method = (b.pay_method || 'check').trim();
    const payInput = { bankAccountId: ba?.id, method, invoiceIds };
    if (method === 'check') {
      payInput.checkNumber = b.check_number;
      payInput.paymentDate = b.check_due_date;
    } else if (method === 'transfer') {
      payInput.reference = b.transfer_ref;
      payInput.paymentDate = b.transfer_date;
    } else if (method === 'cash') {
      payInput.payerName = b.cash_payer;
      payInput.paymentDate = b.cash_date;
    } else if (method === 'credit') {
      payInput.cardLast4 = b.card_last4;
      payInput.paymentDate = b.credit_date;
    } else if (method === 'standing_order') {
      payInput.reference = b.so_ref;
      payInput.paymentDate = b.so_date;
    }
    if (!payInput.paymentDate) payInput.paymentDate = new Date().toISOString().slice(0, 10);
    const payment = await createPayment(payInput, req.user);
    return res.redirect(303, `/payments/${payment.id}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      return res.status(400).render('invoices/new', {
        title: 'חשבונית חדשה',
        ...(await formData(req.scope.companyIds)),
        values: { supplier_id: supplierId, store_id: storeId },
        warnings: [],
        error: err.message,
        notice: null,
        ...(await batchContext(supplierId, storeId)),
      });
    }
    next(err);
  }
});

// Edit an invoice's core fields (available until it is paid).
function invoiceToValues(inv) {
  return {
    supplier_id: inv.supplier_id,
    store_id: inv.store_id,
    invoice_number: inv.invoice_number,
    allocation_number: inv.allocation_number || '',
    invoice_date: inv.invoice_date,
    doc_type: inv.doc_type,
    amount_before_vat: fromAgorot(Math.abs(inv.amount_before_vat)),
    vat_amount: fromAgorot(Math.abs(inv.vat_amount)),
  };
}

router.get('/:id/edit', requirePermission('edit_invoice'), async (req, res, next) => {
  try {
    const invoice = await getInvoiceDetail(Number(req.params.id));
    if (invoice.status === 'paid') return res.redirect(303, `/invoices/${invoice.id}`);
    res.render('invoices/edit', { title: `עריכת חשבונית #${invoice.id}`, invoice, values: invoiceToValues(invoice), ...(await formData(req.scope.companyIds)), error: null });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/edit', requirePermission('edit_invoice'), async (req, res, next) => {
  const id = Number(req.params.id);
  const b = req.body;
  try {
    const fields = {
      supplierId: Number(b.supplier_id),
      storeId: Number(b.store_id),
      invoiceNumber: b.invoice_number,
      allocationNumber: b.allocation_number,
      invoiceDate: b.invoice_date,
      amountBeforeVat: toAgorot(b.amount_before_vat),
      vatAmount: toAgorot(b.vat_amount),
      docType: b.doc_type,
    };
    // Non-owners: queue the edit for the owner's approval instead of applying it.
    if (req.user.role !== 'owner') {
      const current = await getInvoiceDetail(id);
      await submitRequest(
        { action: 'invoice.update', entityType: 'invoice', entityId: id, payload: { id, fields }, summary: describeInvoice(current, fields) },
        req.user,
      );
      return res.render('invoices/edit', {
        title: `עריכת חשבונית #${id}`,
        invoice: current,
        values: b,
        ...(await formData(req.scope.companyIds)),
        error: null,
        notice: 'בקשת העריכה נשלחה לאישור הבעלים. השינוי יבוצע לאחר אישור.',
      });
    }
    await updateInvoice(id, fields, req.user);
    res.redirect(303, `/invoices/${id}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) {
      const invoice = await getInvoiceDetail(id);
      return res.status(400).render('invoices/edit', { title: `עריכת חשבונית #${id}`, invoice, values: b, ...(await formData(req.scope.companyIds)), error: err.message });
    }
    next(err);
  }
});

// Serve an invoice's image (stage 1b).
router.get('/:id/image', async (req, res, next) => {
  try {
    const invoice = await getInvoice(Number(req.params.id));
    if (!invoice.image_path) return res.status(404).send('אין תמונה');
    const { buffer, contentType } = await getObject(invoice.image_path);
    return res.type(contentType).send(buffer);
  } catch (err) {
    next(err);
  }
});

// Serve one page of the scan this invoice was created from. Lives under /invoices (not /scan)
// on purpose: reading an invoice you may already see must not require the nav_scan page
// permission. Scoped by the same router.param('id') company guard as every other invoice route.
router.get('/:id/scan-image/:idx', async (req, res, next) => {
  try {
    const { scanPages } = await scanContext(Number(req.params.id));
    const ref = scanPages[Number(req.params.idx)];
    if (!ref) return res.status(404).send('אין תמונה');
    const { buffer, contentType } = await getObject(ref);
    return res.type(contentType).send(buffer);
  } catch (err) {
    next(err);
  }
});

// Attach or replace an invoice's image.
router.post('/:id/image', handleInvoiceImage, async (req, res, next) => {
  try {
    if (req.uploadError) {
      if (req.file) removeUpload(req.file.filename);
      return renderShow(res, Number(req.params.id), req.uploadError);
    }
    if (!req.file) return renderShow(res, Number(req.params.id), 'לא נבחר קובץ');
    const previous = await setImage(Number(req.params.id), req.file.filename, req.user);
    if (previous) removeUpload(previous);
    res.redirect(303, `/invoices/${req.params.id}`);
  } catch (err) {
    if (req.file) removeUpload(req.file.filename);
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await reconcileR3Hold(id); // self-heal a stale R3 hold before displaying
    res.render('invoices/show', {
      title: `חשבונית`,
      invoice: await getInvoiceDetail(id),
      ocr: await getOcr(id),
      comparison: await compareToInvoice(id),
      cashPayments: await cashPaymentsForInvoice(id),
      pendingPayReq: await pendingRequestFor('invoice', id, 'invoice.approve_payment'),
      pendingReleaseReq: await pendingRequestFor('invoice', id, 'invoice.release_hold'),
      ...(await scanContext(id)),
      notice: req.query.sent === 'pay' ? 'בקשת אישור התשלום נשלחה למנהל/בעלים.'
        : req.query.sent === 'release' ? 'בקשת שחרור ההחזקה נשלחה למנהל/בעלים.'
        : req.query.paid === '1' ? 'החשבונית נוצרה והתשלום נוצר ושויך אליה.'
        : req.query.scanned === '1' ? 'החשבונית נקלטה מהצילום, כולל שורות הפריטים וקטלוג המוצרים.' : null,
      error: req.query.payfail ? `החשבונית נשמרה, אך יצירת הצ׳ק נכשלה: ${req.query.payfail}` : null,
      ocrOpen: req.query.ocr === '1',
    });
  } catch (err) {
    next(err);
  }
});

// Stage 3: run OCR on the invoice image and store the extracted-fields comparison.
router.post('/:id/ocr', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    await runOcrForInvoice(id, req.user);
    res.redirect(303, `/invoices/${id}?ocr=1`);
  } catch (err) {
    return renderShow(res, id, err.message);
  }
});

// Approve an invoice for payment — owner / store-manager (approve_payment) only. This is the
// action a secretary's payment-approval request unlocks; once approved, payment methods appear.
router.post('/:id/approve', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    if (!userCan(req.user, 'approve_payment')) {
      throw new AuthError('אישור תשלום — נדרשת הרשאת מנהל חנות / בעלים');
    }
    await approveInvoiceForPayment(id, req.user);
    res.redirect(303, `/invoices/${id}`);
  } catch (err) {
    if (err instanceof AuthError || err instanceof RuleError) return renderShow(res, id, err.message);
    next(err);
  }
});

// Secretary asks an owner/manager to approve this invoice for payment. A photo of the invoice is
// mandatory — the approver reviews the scan before releasing funds. Recorded as a change request.
router.post('/:id/request-payment', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const invoice = await getInvoiceDetail(id);
    if (invoice.status === 'paid') throw new RuleError('R', 'החשבונית כבר שולמה');
    if (!invoice.image_path) {
      throw new RuleError('IMG', 'יש לצרף צילום של החשבונית לפני שליחת בקשה לאישור תשלום');
    }
    await submitRequest(
      {
        action: 'invoice.approve_payment',
        entityType: 'invoice',
        entityId: id,
        payload: { id },
        summary: `אישור תשלום — ${invoice.supplier_name} · ${invoice.store_name} · ${fromAgorot(Math.abs(invoice.total_amount))} ₪`,
      },
      req.user,
    );
    res.redirect(303, `/invoices/${id}?sent=pay`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderShow(res, id, err.message);
    next(err);
  }
});

// Move an invoice out of "on hold". Owner/manager release it directly; a secretary — who cannot
// flip a hold placed by an owner/manager — files a release request for approval instead.
router.post('/:id/release', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    if (userCan(req.user, 'approve_payment') || userCan(req.user, 'hold_invoice')) {
      await releaseHold(id, req.user);
      return res.redirect(303, `/invoices/${id}`);
    }
    const invoice = await getInvoiceDetail(id);
    await submitRequest(
      {
        action: 'invoice.release_hold',
        entityType: 'invoice',
        entityId: id,
        payload: { id },
        summary: `שחרור החזקה — ${invoice.supplier_name} · ${invoice.store_name}`,
      },
      req.user,
    );
    res.redirect(303, `/invoices/${id}?sent=release`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderShow(res, id, err.message);
    next(err);
  }
});

router.post('/:id/hold', async (req, res, next) => {
  const id = Number(req.params.id);
  try {
    const type = req.body.reason_type;
    const who = req.user.label || req.user.name || req.user.username;
    let reason;
    if (type === 'credit') reason = `מחכה לזיכוי — הוזן ע"י ${who}`;
    else if (type === 'review') reason = `חשבונית בבירור — הוזן ע"י ${who}`;
    else if (type === 'not_now') reason = `לא לתשלום כרגע — הוזן ע"י ${who}`;
    else reason = (req.body.reason || '').trim() || null;

    // "חשבונית בבירור" may schedule a push reminder on a chosen date.
    if (type === 'review' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.remind_date || '')) {
      await createEvent({ title: `בירור חשבונית #${id}`, eventDate: req.body.remind_date, remind: true }, req.user);
      reason += ` · תזכורת ${req.body.remind_date}`;
    }
    await putOnHold(id, reason, req.user);
    res.redirect(303, `/invoices/${id}`);
  } catch (err) {
    if (err instanceof AuthError || err instanceof RuleError) {
      return renderShow(res, id, err.message);
    }
    next(err);
  }
});

// Delete the invoice image (and its OCR).
router.post('/:id/image/delete', async (req, res, next) => {
  try {
    const previous = await clearImage(Number(req.params.id), req.user);
    if (previous) removeUpload(previous);
    res.redirect(303, `/invoices/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Delete the stored OCR result.
router.post('/:id/ocr/delete', async (req, res, next) => {
  try {
    await deleteOcr(Number(req.params.id), req.user);
    res.redirect(303, `/invoices/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

// Apply (possibly edited) OCR fields to the invoice — owner applies directly; others queue.
router.post('/:id/ocr/apply', async (req, res, next) => {
  const id = Number(req.params.id);
  const b = req.body;
  try {
    const current = await getInvoiceDetail(id);
    const fields = {
      supplierId: current.supplier_id,
      storeId: current.store_id,
      invoiceNumber: current.invoice_number,
      allocationNumber: (b.allocation_number || current.allocation_number) || null,
      invoiceDate: b.invoice_date || current.invoice_date,
      amountBeforeVat: b.amount_before_vat ? toAgorot(b.amount_before_vat) : Math.abs(current.amount_before_vat),
      vatAmount: b.vat_amount ? toAgorot(b.vat_amount) : Math.abs(current.vat_amount),
      docType: current.doc_type,
    };
    if (req.user.role !== 'owner') {
      await submitRequest(
        { action: 'invoice.update', entityType: 'invoice', entityId: id, payload: { id, fields }, summary: describeInvoice(current, fields) },
        req.user,
      );
      return renderShow(res, id, null, 'עדכון מ-OCR נשלח לאישור הבעלים.');
    }
    await updateInvoice(id, fields, req.user);
    res.redirect(303, `/invoices/${id}`);
  } catch (err) {
    if (err instanceof RuleError || err instanceof AuthError) return renderShow(res, id, err.message);
    next(err);
  }
});

router.post('/:id/allocation', async (req, res, next) => {
  try {
    await setAllocationNumber(Number(req.params.id), req.body.allocation_number, req.user);
    res.redirect(303, `/invoices/${req.params.id}`);
  } catch (err) {
    if (err instanceof RuleError) {
      return renderShow(res, Number(req.params.id), err.message);
    }
    next(err);
  }
});

async function renderShow(res, id, error, notice = null) {
  await reconcileR3Hold(id); // self-heal a stale R3 hold before displaying
  res.status(error ? 400 : 200).render('invoices/show', {
    title: `חשבונית`,
    invoice: await getInvoiceDetail(id),
    ocr: await getOcr(id),
    comparison: await compareToInvoice(id),
    cashPayments: await cashPaymentsForInvoice(id),
    pendingPayReq: await pendingRequestFor('invoice', id, 'invoice.approve_payment'),
    pendingReleaseReq: await pendingRequestFor('invoice', id, 'invoice.release_hold'),
    ...(await scanContext(id)),
    error,
    notice,
    ocrOpen: false,
  });
}

export default router;
