import { getExecutor, tx, nowTs } from '../db/adapter.js';

// supplier_catalog — the catalog a SUPPLIER hands us, listing exactly what it sells.
//
// Distinct from master_catalog in both scope and purpose: that one is the public
// price-transparency קטלוג-על, keyed by barcode across the whole retail range, and it answers
// "what product is this barcode". This one is per-supplier and answers the harder question these
// tobacco invoices pose — "what product is this LINE", when the line prints no barcode at all
// (מוצרי איכות קנדים, פיליפ מוריס) or prints the supplier's own item number (גלוברנדס, דובק).
//
// Like every catalog path in this app it is advisory: it offers an identity, and a human adopts
// it with a click. Nothing here is ever written onto a draft automatically.

/** Rows per INSERT. These catalogs are 50-110 rows, so one chunk covers a whole import. */
const INSERT_CHUNK = 200;

const COLS = [
  'supplier_id', 'barcode', 'name', 'name_norm', 'sku', 'pack_type', 'pack_units',
  'brand', 'category', 'linked_barcode', 'imported_at',
];

/**
 * Replace a supplier's catalog with the contents of a freshly parsed file.
 *
 * Replace rather than merge, and deliberately: this file IS the supplier's current range, so a
 * product missing from it has been discontinued. Merging would leave last year's items in place
 * to be matched against forever, and a discontinued product is exactly the kind of wrong answer
 * nobody would think to question. The swap runs in one transaction, so a failed import leaves
 * the previous catalog intact rather than nothing at all.
 *
 * @param {number} supplierId
 * @param {Array<object>} items from parseSupplierCatalog()
 * @returns {Promise<{imported: number, replaced: number}>}
 */
export async function importSupplierCatalog(supplierId, items, x = getExecutor()) {
  const ts = nowTs();
  const rows = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item?.barcode || !item?.name || seen.has(item.barcode)) continue;
    seen.add(item.barcode);
    rows.push([
      supplierId,
      item.barcode,
      item.name,
      item.nameNorm ?? '',
      item.sku ?? null,
      item.packType ?? null,
      item.packUnits ?? null,
      item.brand ?? null,
      item.category ?? null,
      item.linkedBarcode ?? null,
      ts,
    ]);
  }

  const before = await x.one('SELECT COUNT(*) AS n FROM supplier_catalog WHERE supplier_id = ?', [supplierId]);
  await tx(async (t) => {
    await t.run('DELETE FROM supplier_catalog WHERE supplier_id = ?', [supplierId]);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      const placeholders = chunk.map(() => `(${COLS.map(() => '?').join(',')})`).join(',');
      await t.run(`INSERT INTO supplier_catalog (${COLS.join(',')}) VALUES ${placeholders}`, chunk.flat());
    }
  });
  return { imported: rows.length, replaced: Number(before?.n ?? 0) };
}

/**
 * One supplier's whole catalog, for the pure matcher. These are 50-110 rows, so the draft loads
 * all of them once and matches in memory rather than issuing a query per line.
 * @returns {Promise<object[]>}
 */
export async function catalogForSupplier(supplierId, x = getExecutor()) {
  if (!supplierId) return [];
  return x.many('SELECT * FROM supplier_catalog WHERE supplier_id = ? ORDER BY name_norm, pack_units', [
    supplierId,
  ]);
}

/** Which suppliers have a catalog loaded, and how big — the settings screen's list. */
export async function supplierCatalogSummary(x = getExecutor()) {
  return x.many(
    `SELECT sc.supplier_id, s.name AS supplier_name,
            COUNT(*) AS row_count,
            COUNT(DISTINCT sc.name_norm) AS products,
            MAX(sc.imported_at) AS imported_at
       FROM supplier_catalog sc
       JOIN suppliers s ON s.id = sc.supplier_id
      GROUP BY sc.supplier_id, s.name
      ORDER BY s.name`,
    [],
  );
}

/** Drop a supplier's catalog entirely. */
export async function clearSupplierCatalog(supplierId, x = getExecutor()) {
  await x.run('DELETE FROM supplier_catalog WHERE supplier_id = ?', [supplierId]);
}
