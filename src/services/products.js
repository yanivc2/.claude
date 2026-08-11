import { getExecutor, nowTs } from '../db/adapter.js';
import { NotFoundError } from '../lib/errors.js';

// קטלוג המוצרים (stage 5). The catalog is a by-product of approving scanned invoices: every
// approved line is matched to a product of that supplier (or creates one), and its unit cost is
// appended to the product's price history. Prices are integer agorot, before VAT, and ALWAYS
// positive — a credit note reverses an invoice, it does not define a new catalog price.

/**
 * Canonical comparison form of a product name: lowercase latin, no quotes/gershayim,
 * no punctuation, single spaces. Same spirit as normalizeSupplierName, but nothing is
 * dropped as a "legal suffix" — every word of a product name is meaningful.
 * @param {string|null|undefined} s
 * @returns {string} normalized name ('' when nothing meaningful is left)
 */
function normalizeProductName(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .toLowerCase()
    .replace(/["'`´׳״‘’“”]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Trimmed non-empty string, or null. */
function str(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t === '' ? null : t;
}

/**
 * Find the catalog row an invoice line refers to, within one supplier.
 * Priority: barcode (a strong key, unique per supplier) → מק"ט → normalized name.
 *
 * @param {number} supplierId
 * @param {{barcode?: string|null, sku?: string|null, name?: string|null}} line
 * @param {import('../db/adapter.js').Executor} [x]
 * @returns {Promise<object|null>} the product row, or null when the supplier has no match
 */
export async function findProduct(supplierId, { barcode = null, sku = null, name = null } = {}, x = getExecutor()) {
  const bc = str(barcode);
  if (bc) {
    const hit = await x.one('SELECT * FROM products WHERE supplier_id = ? AND barcode = ?', [supplierId, bc]);
    if (hit) return hit;
  }
  const sk = str(sku);
  if (sk) {
    const hit = await x.one('SELECT * FROM products WHERE supplier_id = ? AND sku = ?', [supplierId, sk]);
    if (hit) return hit;
  }
  const target = normalizeProductName(name);
  if (!target) return null;
  const rows = await x.many('SELECT * FROM products WHERE supplier_id = ? ORDER BY id', [supplierId]);
  return rows.find((r) => normalizeProductName(r.name) === target) || null;
}

/**
 * Fold the approved lines of one invoice into the supplier's catalog:
 * find-or-create a product per line, backfill a barcode/מק"ט the catalog row was missing,
 * append a price-history row for every line with a known unit cost, and roll `last_cost`
 * forward when this invoice is at least as recent as the one that last set it.
 *
 * Costs must be passed as ABSOLUTE agorot — catalog prices are never negative.
 * Pass `recordPrices: false` (credit notes) to link products without touching price history.
 *
 * @param {number} supplierId
 * @param {number|null} invoiceId  invoice the lines came from (stored on the price rows)
 * @param {string} invoiceDate  'YYYY-MM-DD'
 * @param {Array<{lineNo:number, name:string|null, barcode?:string|null, sku?:string|null,
 *   quantity?:number|null, unitCost?:number|null}>} lines
 * @param {{recordPrices?: boolean}} [opts]
 * @param {import('../db/adapter.js').Executor} [x]
 * @returns {Promise<Map<number, number>>} lineNo → productId (lines without a name are skipped)
 */
export async function upsertProductsFromLines(
  supplierId,
  invoiceId,
  invoiceDate,
  lines,
  { recordPrices = true } = {},
  x = getExecutor(),
) {
  /** @type {Map<number, number>} */
  const byLine = new Map();
  const ts = nowTs();

  for (const line of lines || []) {
    const name = str(line.name);
    if (!name) continue; // a nameless line cannot become a catalog entry
    const barcode = str(line.barcode);
    const sku = str(line.sku);
    const unitCost = line.unitCost === null || line.unitCost === undefined ? null : Math.abs(line.unitCost);

    let product = await findProduct(supplierId, { barcode, sku, name }, x);
    if (!product) {
      const info = await x.run(
        'INSERT INTO products (supplier_id, name, barcode, sku, last_cost, last_cost_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [supplierId, name, barcode, sku, null, null, ts],
      );
      product = await x.one('SELECT * FROM products WHERE id = ?', [info.lastInsertRowid]);
    } else if ((barcode && !product.barcode) || (sku && !product.sku)) {
      // The catalog row was created from a page that didn't print the barcode/מק"ט — fill it in.
      const nextBarcode = product.barcode || barcode;
      const nextSku = product.sku || sku;
      await x.run('UPDATE products SET barcode = ?, sku = ?, updated_at = ? WHERE id = ?', [
        nextBarcode,
        nextSku,
        ts,
        product.id,
      ]);
      product = { ...product, barcode: nextBarcode, sku: nextSku };
    }

    byLine.set(line.lineNo, product.id);
    if (!recordPrices || unitCost === null) continue;

    await x.run(
      'INSERT INTO product_prices (product_id, invoice_id, price, quantity, price_date) VALUES (?, ?, ?, ?, ?)',
      // quantity records the count the per-single price refers to — the singles count (כ.בודד)
      // when the line has one, otherwise the printed quantity.
      [product.id, invoiceId, unitCost, line.unitQuantity ?? line.quantity ?? null, invoiceDate],
    );
    // last_cost tracks the most recent invoice date, not the most recent entry — a late-entered
    // old invoice must not overwrite a newer price. Equal dates: the later entry wins.
    if (!product.last_cost_date || invoiceDate >= product.last_cost_date) {
      await x.run('UPDATE products SET last_cost = ?, last_cost_date = ?, updated_at = ? WHERE id = ?', [
        unitCost,
        invoiceDate,
        ts,
        product.id,
      ]);
    }
  }

  return byLine;
}

/**
 * Catalog list for the products screen: supplier name joined in, free-text search over
 * name / barcode / מק"ט. Capped at 500 rows — the screen filters, it does not paginate.
 * @param {{supplierId?: number|null, q?: string|null}} [filters]
 * @param {import('../db/adapter.js').Executor} [x]
 */
export async function listProducts({ supplierId = null, q = null } = {}, x = getExecutor()) {
  let sql = `SELECT p.*, s.name AS supplier_name
               FROM products p
               JOIN suppliers s ON s.id = p.supplier_id
              WHERE 1 = 1`;
  const params = [];
  if (supplierId) {
    sql += ' AND p.supplier_id = ?';
    params.push(supplierId);
  }
  const term = str(q);
  if (term) {
    sql += ' AND (p.name LIKE ? OR p.barcode LIKE ? OR p.sku LIKE ?)';
    params.push(`%${term}%`, `%${term}%`, `%${term}%`);
  }
  sql += ' ORDER BY s.name, p.name LIMIT 500';
  return x.many(sql, params);
}

/**
 * One product with its full purchase-price history (newest invoice first), for the trend view.
 * @returns {Promise<{product: object, prices: object[]}>}
 */
export async function getProductWithHistory(id, x = getExecutor()) {
  const product = await x.one(
    `SELECT p.*, s.name AS supplier_name
       FROM products p
       JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.id = ?`,
    [id],
  );
  if (!product) throw new NotFoundError(`מוצר ${id} לא נמצא`);
  const prices = await x.many(
    `SELECT pp.*, i.invoice_number, i.invoice_date
       FROM product_prices pp
       LEFT JOIN invoices i ON i.id = pp.invoice_id
      WHERE pp.product_id = ?
      ORDER BY pp.price_date DESC, pp.id DESC`,
    [id],
  );
  return { product, prices };
}
