import { Router } from 'express';
import {
  listInvoices,
  getInvoiceDetail,
  getInvoice,
  createInvoice,
  approveInvoiceForPayment,
  putOnHold,
  setAllocationNumber,
  setImage,
} from '../services/invoices.js';
import { listSuppliers } from '../services/suppliers.js';
import { runOcrForInvoice, compareToInvoice, getOcr } from '../services/ocr.js';
import { getExecutor } from '../db/adapter.js';
import { toAgorot } from '../lib/money.js';
import { handleInvoiceImage } from '../middleware/upload.js';
import { getObject, del as removeStored } from '../lib/storage.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

/** Best-effort delete of a stored upload by its ref (fire-and-forget; never throws). */
function removeUpload(ref) {
  if (ref) void removeStored(ref);
}

async function formData() {
  return {
    suppliers: await listSuppliers(),
    stores: await getExecutor().many(
      `SELECT st.id, st.name, c.name AS company_name
         FROM stores st JOIN companies c ON c.id = st.company_id ORDER BY c.name, st.name`,
      [],
    ),
  };
}

router.get('/', async (req, res, next) => {
  try {
    res.render('invoices/index', {
      title: 'חשבוניות',
      invoices: await listInvoices({ status: req.query.status || null }),
      filter: req.query.status || '',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/new', async (req, res, next) => {
  try {
    res.render('invoices/new', {
      title: 'חשבונית חדשה',
      ...(await formData()),
      values: {},
      warnings: [],
      error: null,
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
      ...(await formData()),
      values: b,
      warnings: [],
      error: null,
      uploadedImage: imagePath,
      ...extra,
    });
  };

  if (req.uploadError) {
    if (imagePath) removeUpload(imagePath);
    return res.status(400).render('invoices/new', {
      title: 'חשבונית חדשה',
      ...(await formData()),
      values: b,
      warnings: [],
      error: req.uploadError,
      uploadedImage: null,
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
    return res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    if (err instanceof RuleError && err.meta?.needsConfirmation) {
      return res.status(200).render('invoices/new', {
        title: 'חשבונית חדשה — אישור אזהרות',
        ...(await formData()),
        values: b,
        warnings: err.meta.warnings,
        error: null,
        uploadedImage: imagePath,
      });
    }
    if (err instanceof RuleError) {
      return rerender({ error: err.message });
    }
    if (req.file) removeUpload(req.file.filename);
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
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    if (req.file) removeUpload(req.file.filename);
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    res.render('invoices/show', {
      title: `חשבונית #${id}`,
      invoice: await getInvoiceDetail(id),
      ocr: await getOcr(id),
      comparison: await compareToInvoice(id),
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
    res.redirect(`/invoices/${id}`);
  } catch (err) {
    return renderShow(res, id, err.message);
  }
});

router.post('/:id/approve', async (req, res, next) => {
  try {
    await approveInvoiceForPayment(Number(req.params.id), req.user);
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    if (err instanceof AuthError || err instanceof RuleError) {
      return renderShow(res, Number(req.params.id), err.message);
    }
    next(err);
  }
});

router.post('/:id/hold', async (req, res, next) => {
  try {
    await putOnHold(Number(req.params.id), req.body.reason || null, req.user);
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    if (err instanceof AuthError || err instanceof RuleError) {
      return renderShow(res, Number(req.params.id), err.message);
    }
    next(err);
  }
});

router.post('/:id/allocation', async (req, res, next) => {
  try {
    await setAllocationNumber(Number(req.params.id), req.body.allocation_number, req.user);
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    if (err instanceof RuleError) {
      return renderShow(res, Number(req.params.id), err.message);
    }
    next(err);
  }
});

async function renderShow(res, id, error) {
  res.status(400).render('invoices/show', {
    title: `חשבונית #${id}`,
    invoice: await getInvoiceDetail(id),
    ocr: await getOcr(id),
    comparison: await compareToInvoice(id),
    error,
  });
}

export default router;
