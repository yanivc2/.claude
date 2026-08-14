import { getExecutor, tx, nowTs } from '../db/adapter.js';
import { normalizeSupplierName } from '../lib/supplierMatch.js';

// קטלוג-על (master_catalog): product identity imported from the public price-transparency
// files — barcode → canonical name, manufacturer, pack size. Advisory only: the scan review
// screen uses it to confirm barcodes and suggest names. retail_price is display-only and is
// never compared to purchase prices.

/** Inserted-rows chunk: 200 rows × 11 columns stays far below pg's placeholder limit. */
const INSERT_CHUNK = 200;

const COLS = [
  'barcode', 'name', 'manufacturer_name', 'manufacturer_norm', 'unit_qty', 'quantity',
  'qty_in_package', 'retail_price', 'source_chain', 'source_store', 'imported_at',
];

/**
 * Upsert parsed PriceFull items into master_catalog. No ON CONFLICT — the whole table is
 * read once into memory (≤~30k skinny rows) and the input is partitioned into new/changed,
 * which keeps both SQL dialects and pg-mem happy.
 *
 * @param {Array<{barcode:string,name:string,manufacturerName:string|null,unitQty:string|null,
 *   quantity:number|null,qtyInPackage:number|null,retailPrice:number|null}>} items
 * @param {{chain?: string, store?: string|null}} [source]
 * @returns {Promise<{inserted:number, updated:number, unchanged:number}>}
 */
export async function importCatalogItems(items, { chain = 'shufersal', store = null } = {}, x = getExecutor()) {
  const existing = new Map();
  for (const row of await x.many('SELECT barcode, name, manufacturer_name, retail_price FROM master_catalog', [])) {
    existing.set(row.barcode, row);
  }

  const ts = nowTs();
  const fresh = [];
  const changed = [];
  let unchanged = 0;
  const seen = new Set();
  for (const item of items || []) {
    if (!item?.barcode || seen.has(item.barcode)) continue; // first occurrence wins
    seen.add(item.barcode);
    const row = [
      item.barcode,
      item.name,
      item.manufacturerName ?? null,
      item.manufacturerName ? normalizeSupplierName(item.manufacturerName) || null : null,
      item.unitQty ?? null,
      item.quantity ?? null,
      item.qtyInPackage ?? null,
      item.retailPrice ?? null,
      chain,
      store,
      ts,
    ];
    const prev = existing.get(item.barcode);
    if (!prev) {
      fresh.push(row);
    } else if (
      prev.name !== item.name ||
      (prev.manufacturer_name ?? null) !== (item.manufacturerName ?? null) ||
      Number(prev.retail_price ?? -1) !== Number(item.retailPrice ?? -1)
    ) {
      changed.push(row);
    } else {
      unchanged++;
    }
  }

  for (let i = 0; i < fresh.length; i += INSERT_CHUNK) {
    const chunk = fresh.slice(i, i + INSERT_CHUNK);
    const placeholders = chunk.map(() => `(${COLS.map(() => '?').join(',')})`).join(',');
    await tx(async (t) => {
      await t.run(`INSERT INTO master_catalog (${COLS.join(',')}) VALUES ${placeholders}`, chunk.flat());
    });
  }
  for (const row of changed) {
    const barcode = row[0];
    await x.run(
      `UPDATE master_catalog
          SET name = ?, manufacturer_name = ?, manufacturer_norm = ?, unit_qty = ?, quantity = ?,
              qty_in_package = ?, retail_price = ?, source_chain = ?, source_store = ?, imported_at = ?
        WHERE barcode = ?`,
      [...row.slice(1), barcode],
    );
  }

  return { inserted: fresh.length, updated: changed.length, unchanged };
}

/**
 * Catalog rows for a set of barcodes (the draft's own lines) — a small Map for the pure
 * validator. Empty/duplicate/blank codes are dropped.
 * @returns {Promise<Map<string, object>>}
 */
export async function lookupByBarcodes(barcodes, x = getExecutor()) {
  const codes = [...new Set((barcodes || []).map((b) => (b == null ? '' : String(b).trim())).filter(Boolean))];
  const map = new Map();
  if (codes.length === 0) return map;
  const rows = await x.many(
    `SELECT * FROM master_catalog WHERE barcode IN (${codes.map(() => '?').join(',')})`,
    codes,
  );
  for (const row of rows) map.set(row.barcode, row);
  return map;
}

/** Shortest printed code we will try to resolve; see lookupByCodes for why 5. */
export const MIN_SUFFIX_LEN = 5;

/**
 * Resolve SHORTENED barcodes — the codes many suppliers print instead of the full EAN.
 *
 * A Tnuva invoice prints `42435`, and the product's real barcode is `7290000042435`: the printed
 * code is a suffix of the EAN-13. Measured against a 38,279-barcode catalog:
 *
 *   suffix len   unique   ambiguous   worst
 *        4          897      8,849      17
 *        5       25,898      5,772       5
 *        6       36,793        738       4
 *        8       38,263          8       2
 *
 * The floor is 5, not 6, because real invoices print 5-digit codes (`42435`, `43890`) and the
 * ambiguity at that length is *handled* rather than guessed: every candidate comes back and a
 * human picks. At 4 digits there is nothing to pick from — 90% of codes would be ambiguous.
 *
 * Returns every candidate per code — deciding between them is the caller's job, and a human's.
 * One statement per draft (a few dozen codes) is a sequential scan of the catalog; at this size
 * that is a few milliseconds, and it costs no index and no denormalized column.
 *
 * @param {string[]} codes printed codes, any length; short/blank/duplicate ones are dropped
 * @returns {Promise<Map<string, object[]>>} printed code → candidate rows
 */
export async function lookupByCodes(codes, x = getExecutor()) {
  const wanted = [
    ...new Set(
      (codes || [])
        .map((c) => (c == null ? '' : String(c).trim()))
        .filter((c) => c.length >= MIN_SUFFIX_LEN && /^\d+$/.test(c)),
    ),
  ];
  const map = new Map();
  if (wanted.length === 0) return map;

  const rows = await x.many(
    `SELECT * FROM master_catalog WHERE ${wanted.map(() => 'barcode LIKE ?').join(' OR ')}`,
    wanted.map((c) => `%${c}`),
  );
  // One row can satisfy several codes (a short code is a suffix of a longer one), so fan out
  // rather than assuming a row belongs to the code that fetched it.
  for (const code of wanted) {
    const hits = rows.filter((r) => String(r.barcode).endsWith(code));
    if (hits.length) map.set(code, hits);
  }
  return map;
}

/** Manufacturers with item counts, biggest first — the browse page's filter dropdown. */
export async function listManufacturers(x = getExecutor()) {
  return x.many(
    `SELECT manufacturer_name, manufacturer_norm, COUNT(*) AS count
       FROM master_catalog
      WHERE manufacturer_name IS NOT NULL
      GROUP BY manufacturer_name, manufacturer_norm
      ORDER BY count DESC, manufacturer_name`,
    [],
  );
}

/**
 * Browse the catalog — filter by manufacturer (normalized key) and/or free text over
 * name/barcode. Capped like listProducts: the screen filters, it does not paginate.
 */
export async function listCatalog({ manufacturer = null, q = null } = {}, x = getExecutor()) {
  let sql = 'SELECT * FROM master_catalog WHERE 1 = 1';
  const params = [];
  if (manufacturer) {
    sql += ' AND manufacturer_norm = ?';
    params.push(manufacturer);
  }
  const term = q === null || q === undefined ? '' : String(q).trim();
  if (term) {
    sql += ' AND (name LIKE ? OR barcode LIKE ?)';
    params.push(`%${term}%`, `%${term}%`);
  }
  sql += ' ORDER BY manufacturer_name, name LIMIT 500';
  return x.many(sql, params);
}

/** Headline numbers for the browse page. */
export async function catalogStats(x = getExecutor()) {
  const items = await x.one('SELECT COUNT(*) AS n FROM master_catalog', []);
  const manufacturers = await x.one(
    'SELECT COUNT(DISTINCT manufacturer_norm) AS n FROM master_catalog WHERE manufacturer_norm IS NOT NULL',
    [],
  );
  const last = await x.one('SELECT MAX(imported_at) AS ts FROM master_catalog', []);
  return {
    items: Number(items?.n ?? 0),
    manufacturers: Number(manufacturers?.n ?? 0),
    lastImport: last?.ts ?? null,
  };
}

/**
 * The user-facing deliverable: the whole catalog grouped by manufacturer ("מאסטר קטלוג
 * מחולק לפי ספקים"), served as a JSON download and written to data/ by the importer.
 */
export async function exportGrouped(x = getExecutor()) {
  const rows = await x.many(
    'SELECT * FROM master_catalog ORDER BY manufacturer_name, name',
    [],
  );
  const byManufacturer = new Map();
  for (const r of rows) {
    const key = r.manufacturer_name || 'ללא יצרן';
    if (!byManufacturer.has(key)) {
      byManufacturer.set(key, { manufacturer: key, normalized: r.manufacturer_norm || null, items: [] });
    }
    byManufacturer.get(key).items.push({
      barcode: r.barcode,
      name: r.name,
      unitQty: r.unit_qty,
      quantity: r.quantity === null || r.quantity === undefined ? null : Number(r.quantity),
      qtyInPackage: r.qty_in_package === null || r.qty_in_package === undefined ? null : Number(r.qty_in_package),
      retailPrice: r.retail_price === null || r.retail_price === undefined ? null : Number(r.retail_price),
    });
  }
  const manufacturers = [...byManufacturer.values()]
    .map((m) => ({ ...m, itemCount: m.items.length }))
    .sort((a, b) => b.itemCount - a.itemCount);
  const stats = await catalogStats(x);
  return {
    generatedAt: stats.lastImport,
    sourceChain: rows[0]?.source_chain ?? 'shufersal',
    itemCount: stats.items,
    manufacturers,
  };
}
