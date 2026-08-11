import { Router } from 'express';
import { listProducts, getProductWithHistory } from '../services/products.js';
import { listSuppliers } from '../services/suppliers.js';
import { listCatalog, listManufacturers, catalogStats, exportGrouped } from '../services/masterCatalog.js';

// קטלוג המוצרים (stage 5) — read-only screens over the catalog that approving scanned
// invoices builds: a searchable list and a per-product purchase-price history.
// Plus קטלוג-העל (master catalog): the imported industry-wide barcode→product reference.
// Mounted behind requirePageAccess('nav_products') in src/app.js.

const router = Router();

// NOTE: /master routes MUST be registered before /:id, or Express treats "master" as an id.
router.get('/master', async (req, res, next) => {
  try {
    const manufacturer = (req.query.manufacturer || '').trim() || null;
    const q = (req.query.q || '').trim() || null;
    res.render('products/master', {
      title: 'קטלוג-על',
      stats: await catalogStats(),
      manufacturers: await listManufacturers(),
      items: await listCatalog({ manufacturer, q }),
      manufacturer: manufacturer || '',
      q: q || '',
    });
  } catch (err) {
    next(err);
  }
});

// The user-facing deliverable: the whole master catalog as JSON, grouped by manufacturer.
router.get('/master/export.json', async (req, res, next) => {
  try {
    res.attachment('master-catalog.json');
    res.json(await exportGrouped());
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const supplierId = req.query.supplier ? Number(req.query.supplier) : null;
    const q = (req.query.q || '').trim() || null;
    res.render('products/index', {
      title: 'מוצרים',
      products: await listProducts({ supplierId, q }),
      suppliers: await listSuppliers(),
      supplierId,
      q: q || '',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { product, prices } = await getProductWithHistory(Number(req.params.id));
    res.render('products/show', { title: product.name, product, prices });
  } catch (err) {
    next(err);
  }
});

export default router;
