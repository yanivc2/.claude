// Parse an owner-supplied catalog file — .xlsx, or CSV/TSV with a Hebrew header row — into the
// item shape importCatalogItems consumes. Pure: no I/O, no DB.
//
// Three things this file exists to survive, all seen on real uploads:
//
// 1. **Varying columns.** The same catalog arrived once with 14 columns and once with 7. Headers
//    are matched by name, and anything unrecognised is ignored — so the owner never has to trim a
//    file before uploading it. (Trimming is in fact how the damage below got introduced.)
//
// 2. **Excel eats leading zeros.** Opening a catalog in a spreadsheet and saving it as CSV turns
//    the barcode column into numbers: `010181040009` comes back as `10181040009`. On one real file
//    that silently corrupted 1,247 of 38,279 barcodes — the row count, the product count and the
//    file itself all still looked perfectly fine.
//
//    A barcode is a GTIN, which is 8, 12, 13 or 14 digits and carries a check digit. So a code of
//    a wrong length can be zero-padded back to the next valid length and CONFIRMED with the
//    checksum. On that file the repair recovered 1,247 of 1,247 with no checksum failures — which
//    is what makes it a repair and not a guess. Anything that fails the checksum is skipped and
//    reported, never stored.
//
// 3. **A price column per chain.** A merged four-chain catalog has מחיר שופרסל / מחיר רמי לוי /
//    מחיר טיב טעם / מחיר קרפור instead of one מחיר מדף. They all feed the single display-only
//    retail_price, and the median of whichever are present represents a shelf price better than
//    any one chain does.

import { eanChecksumOk } from './ean.js';
import { toAgorotFromNumber } from './extractValidate.js';
import { looksLikeXlsx, readXlsx } from './xlsxRead.js';

/** GTIN lengths, shortest first — the repair pads up to the next one that fits. */
const GTIN_LENGTHS = [8, 12, 13, 14];

/**
 * Header aliases → our field names. Matching is done on a squashed form of the header, so
 * `יח' אריזה`, `יח אריזה` and `יחידות באריזה` all land on the same field.
 */
const HEADERS = {
  ברקוד: 'barcode',
  barcode: 'barcode',
  שם: 'name',
  שםמוצר: 'name',
  name: 'name',
  מקט: 'sku',
  מקט_: 'sku',
  sku: 'sku',
  יצרן: 'manufacturerName',
  manufacturer: 'manufacturerName',
  יחאריזה: 'qtyInPackage',
  יחידותבאריזה: 'qtyInPackage',
  כמות: 'quantity',
  יחידתמידה: 'unitQty',
  מחירמדף: 'retailPrice',
  // A merged multi-chain catalog carries one price column per chain. They all feed the same
  // display-only field; parseRows takes the median of whichever are present, which represents a
  // shelf price better than any single chain does.
  מחירשופרסל: 'retailPrice',
  מחיררמילוי: 'retailPrice',
  מחירטיבטעם: 'retailPrice',
  מחירקרפור: 'retailPrice',
  מחירויקטורי: 'retailPrice',
  מחירמדףמינ: 'ignore',
  מחירמדףמקס: 'ignore',
};

/** Squash a header for matching: drop quotes, apostrophes, spaces and punctuation. */
function headerKey(raw) {
  return String(raw || '')
    .replace(/^﻿/, '')
    .replace(/["'׳״.\-_\s]/g, '')
    .trim();
}

/**
 * Split one delimited line, honouring RFC-4180 quoting: `"שם, עם פסיק"` is one field and `""`
 * inside a quoted field is a literal quote. Hebrew product names contain both.
 */
function splitLine(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Comma or tab, whichever appears more often in the header line. */
function detectDelimiter(headerLine) {
  return (headerLine.match(/\t/g) || []).length > (headerLine.match(/,/g) || []).length ? '\t' : ',';
}

/**
 * Normalize a printed barcode, repairing a spreadsheet's stripped leading zeros.
 * @returns {{barcode: string|null, repaired: boolean}} barcode null = unusable
 */
export function normalizeBarcode(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return { barcode: null, repaired: false };
  if (GTIN_LENGTHS.includes(digits.length)) return { barcode: digits, repaired: false };

  // Wrong length: try padding up to each longer GTIN length and let the check digit decide.
  for (const len of GTIN_LENGTHS) {
    if (len <= digits.length) continue;
    const padded = digits.padStart(len, '0');
    if (eanChecksumOk(padded) === true) return { barcode: padded, repaired: true };
  }
  return { barcode: null, repaired: false };
}

function num(value) {
  const s = String(value ?? '').replace(/[^\d.-]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function str(value) {
  const s = String(value ?? '').trim();
  return s === '' ? null : s;
}

/** Median of the numbers present — a multi-chain file's shelf price, not any one chain's. */
function medianPrice(values) {
  const nums = values.map(num).filter((n) => n !== null && n > 0).sort((a, b) => a - b);
  if (nums.length === 0) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

/** The file as a matrix of cell strings: an xlsx workbook, or a delimited text file. */
function toRows(input) {
  if (Buffer.isBuffer(input) && looksLikeXlsx(input)) return readXlsx(input);
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const delimiter = detectDelimiter(lines[0]);
  return lines.map((l) => splitLine(l, delimiter));
}

/**
 * The field each column feeds, by header name: `barcode`, `name`, …, `'ignore'` for a column we
 * recognise and deliberately skip, or `null` for one we do not know at all.
 *
 * Exported because the browser-side reader (`public/catalog-upload.js`) asks the server which
 * columns are worth sending before it streams a large file — the mapping stays here, in one place.
 *
 * @param {string[]} headerRow the file's first row
 * @returns {Array<string|null>} one entry per column
 */
export function mapHeaders(headerRow) {
  return (headerRow || []).map((h) => HEADERS[headerKey(h)] || null);
}

/**
 * Parse data rows that have already been mapped to a header, into items plus a report of what was
 * dropped and why. This is the shared core: a whole file goes through it once, and a streamed
 * upload calls it per batch.
 *
 * Note for the batched caller: `duplicate` counts repeats **within this call**. A barcode that
 * repeats across two batches is not lost — it lands as an update of the row the earlier batch
 * inserted — so inserted/updated stay correct while `duplicate` only ever undercounts.
 *
 * @param {Array<string|null>} headers from mapHeaders
 * @param {string[][]} rows data rows (no header row)
 * @returns {{items: Array<object>, stats: {rows:number, kept:number, repaired:number,
 *   noBarcode:number, badBarcode:number, duplicate:number, columns: string[]}}}
 */
export function parseCatalogRows(headers, rows) {
  const stats = { rows: 0, kept: 0, repaired: 0, noBarcode: 0, badBarcode: 0, duplicate: 0, columns: [] };
  stats.columns = [...new Set((headers || []).filter((h) => h && h !== 'ignore'))];
  if (!stats.columns.includes('barcode') || !stats.columns.includes('name')) {
    return { items: [], stats };
  }

  const items = [];
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i];
    stats.rows++;
    const rec = { retailPrices: [] };
    headers.forEach((field, col) => {
      if (!field || field === 'ignore') return;
      // Several columns can feed one field — a merged catalog has a price per chain.
      if (field === 'retailPrice') rec.retailPrices.push(cells[col]);
      else rec[field] = cells[col];
    });

    const raw = String(rec.barcode ?? '').trim();
    if (!raw) {
      stats.noBarcode++;
      continue;
    }
    const { barcode, repaired } = normalizeBarcode(raw);
    if (!barcode) {
      stats.badBarcode++;
      continue;
    }
    if (repaired) stats.repaired++;
    if (seen.has(barcode)) {
      stats.duplicate++;
      continue;
    }
    const name = str(rec.name);
    if (!name) {
      stats.noBarcode++; // a row without a name is as unusable as one without a barcode
      continue;
    }
    seen.add(barcode);
    items.push({
      barcode,
      name,
      sku: str(rec.sku),
      manufacturerName: str(rec.manufacturerName),
      unitQty: str(rec.unitQty),
      quantity: num(rec.quantity),
      qtyInPackage: num(rec.qtyInPackage),
      retailPrice: toAgorotFromNumber(medianPrice(rec.retailPrices)),
    });
    stats.kept++;
  }
  return { items, stats };
}

/**
 * Parse a whole catalog file: header row + everything under it.
 *
 * @param {Buffer|string} input the raw file (xlsx) or its decoded text (csv/tsv; a BOM is fine)
 * @returns {{items: Array<object>, stats: object}} see parseCatalogRows
 */
export function parseCatalogFile(input) {
  const rows = toRows(input);
  if (rows.length < 2) {
    return { items: [], stats: { rows: 0, kept: 0, repaired: 0, noBarcode: 0, badBarcode: 0, duplicate: 0, columns: [] } };
  }
  return parseCatalogRows(mapHeaders(rows[0]), rows.slice(1));
}
