import path from 'node:path';
import fs from 'node:fs';
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
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { toAgorot } from '../lib/money.js';
import { handleInvoiceImage } from '../middleware/upload.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

/** Safely delete an uploaded file by bare filename (ignores missing files). */
function removeUpload(filename) {
  if (!filename) return;
  const p = path.join(config.uploadsDir, path.basename(filename));
  fs.rm(p, { force: true }, () => {});
}

function formData() {
  return {
    suppliers: listSuppliers(),
    stores: getDb()
      .prepare(
        `SELECT st.id, st.name, c.name AS company_name
           FROM stores st JOIN companies c ON c.id = st.company_id ORDER BY c.name, st.name`,
      )
      .all(),
  };
}

router.get('/', (req, res) => {
  res.render('invoices/index', {
    title: 'חשבוניות',
    invoices: listInvoices({ status: req.query.status || null }),
    filter: req.query.status || '',
  });
});

router.get('/new', (req, res) => {
  res.render('invoices/new', {
    title: 'חשבונית חדשה',
    ...formData(),
    values: {},
    warnings: [],
    error: null,
  });
});

router.post('/', handleInvoiceImage, (req, res, next) => {
  const b = req.body;
  // The uploaded image is carried across a warning/error re-render via a hidden field
  // (file inputs can't be pre-filled), so we never orphan or lose it.
  const carried = b.uploaded_image || null;
  const imagePath = req.file ? req.file.filename : carried;
  // If a new file replaced a previously-carried one, drop the old file.
  if (req.file && carried && carried !== req.file.filename) removeUpload(carried);

  const rerender = (extra) => {
    res.render('invoices/new', {
      title: 'חשבונית חדשה',
      ...formData(),
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
      ...formData(),
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
    const { invoice } = createInvoice(input, req.user);
    return res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    if (err instanceof RuleError && err.meta?.needsConfirmation) {
      return res.status(200).render('invoices/new', {
        title: 'חשבונית חדשה — אישור אזהרות',
        ...formData(),
        values: b,
        warnings: err.meta.warnings,
        error: null,
        uploadedImage: imagePath,
      });
    }
    if (err instanceof RuleError) {
      return rerender({ error: err.message });
    }
    // Unexpected error — don't leave the just-uploaded file orphaned.
    if (req.file) removeUpload(req.file.filename);
    next(err);
  }
});

// Serve an invoice's image (stage 1b). Streams the file by the stored bare filename.
router.get('/:id/image', (req, res, next) => {
  try {
    const invoice = getInvoice(Number(req.params.id));
    if (!invoice.image_path) return res.status(404).send('אין תמונה');
    return res.sendFile(path.join(config.uploadsDir, path.basename(invoice.image_path)));
  } catch (err) {
    next(err);
  }
});

// Attach or replace an invoice's image.
router.post('/:id/image', handleInvoiceImage, (req, res, next) => {
  try {
    if (req.uploadError) {
      if (req.file) removeUpload(req.file.filename);
      return renderShow(res, Number(req.params.id), req.uploadError);
    }
    if (!req.file) return renderShow(res, Number(req.params.id), 'לא נבחר קובץ');
    const previous = setImage(Number(req.params.id), req.file.filename, req.user);
    if (previous) removeUpload(previous);
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    if (req.file) removeUpload(req.file.filename);
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    res.render('invoices/show', {
      title: `חשבונית #${id}`,
      invoice: getInvoiceDetail(id),
      ocr: getOcr(id),
      comparison: compareToInvoice(id),
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
    if (err instanceof RuleError) return renderShow(res, id, err.message);
    // tesseract not installed / recognition failure — show a friendly message, not a 500.
    return renderShow(res, id, err.message);
  }
});

router.post('/:id/approve', (req, res, next) => {
  try {
    approveInvoiceForPayment(Number(req.params.id), req.user);
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    if (err instanceof AuthError || err instanceof RuleError) {
      return renderShow(res, Number(req.params.id), err.message);
    }
    next(err);
  }
});

router.post('/:id/hold', (req, res, next) => {
  try {
    putOnHold(Number(req.params.id), req.body.reason || null, req.user);
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    if (err instanceof AuthError || err instanceof RuleError) {
      return renderShow(res, Number(req.params.id), err.message);
    }
    next(err);
  }
});

router.post('/:id/allocation', (req, res, next) => {
  try {
    setAllocationNumber(Number(req.params.id), req.body.allocation_number, req.user);
    res.redirect(`/invoices/${req.params.id}`);
  } catch (err) {
    if (err instanceof RuleError) {
      return renderShow(res, Number(req.params.id), err.message);
    }
    next(err);
  }
});

function renderShow(res, id, error) {
  res.status(400).render('invoices/show', {
    title: `חשבונית #${id}`,
    invoice: getInvoiceDetail(id),
    ocr: getOcr(id),
    comparison: compareToInvoice(id),
    error,
  });
}

export default router;
