import { Router } from 'express';
import { listProducts, getProductWithHistory } from '../services/products.js';
import { listSuppliers } from '../services/suppliers.js';

// קטלוג המוצרים (stage 5) — read-only screens over the catalog that approving scanned
// invoices builds: a searchable list and a per-product purchase-price history.
// Mounted behind requirePageAccess('nav_products') in src/app.js.

const router = Router();

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
