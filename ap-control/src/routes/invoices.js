import { Router } from 'express';
import {
  listInvoices,
  getInvoiceDetail,
  createInvoice,
  approveInvoiceForPayment,
  putOnHold,
  setAllocationNumber,
} from '../services/invoices.js';
import { listSuppliers } from '../services/suppliers.js';
import { getDb } from '../db/index.js';
import { toAgorot } from '../lib/money.js';
import { RuleError, AuthError } from '../lib/errors.js';

const router = Router();

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

router.post('/', (req, res, next) => {
  const b = req.body;
  let input;
  try {
    input = {
      supplierId: Number(b.supplier_id),
      storeId: Number(b.store_id),
      invoiceNumber: b.invoice_number,
      allocationNumber: b.allocation_number,
      invoiceDate: b.invoice_date,
      amountBeforeVat: toAgorot(b.amount_before_vat),
      vatAmount: toAgorot(b.vat_amount),
      docType: b.doc_type,
      confirm: b.confirm === '1',
      confirmReason: b.confirm_reason || null,
    };
    const { invoice } = createInvoice(input, req.user);
    return res.redirect(`/invoices/${invoice.id}`);
  } catch (err) {
    if (err instanceof RuleError && err.meta?.needsConfirmation) {
      // R2-secondary / R4 soft warnings — show confirm page.
      return res.status(200).render('invoices/new', {
        title: 'חשבונית חדשה — אישור אזהרות',
        ...formData(),
        values: b,
        warnings: err.meta.warnings,
        error: null,
      });
    }
    if (err instanceof RuleError) {
      return res.status(400).render('invoices/new', {
        title: 'חשבונית חדשה',
        ...formData(),
        values: b,
        warnings: [],
        error: err.message,
      });
    }
    next(err);
  }
});

router.get('/:id', (req, res, next) => {
  try {
    res.render('invoices/show', {
      title: `חשבונית #${req.params.id}`,
      invoice: getInvoiceDetail(Number(req.params.id)),
    });
  } catch (err) {
    next(err);
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
    error,
  });
}

export default router;
