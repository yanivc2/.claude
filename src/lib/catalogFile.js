// Parse an owner-supplied catalog file (CSV/TSV with a Hebrew header row) into the item shape
// importCatalogItems consumes. Pure: no I/O, no DB.
//
// Two things this file exists to survive, both seen on real uploads:
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

import { eanChecksumOk } from './ean.js';
import { toAgorotFromNumber } from './extractValidate.js';

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

/**
 * Parse a catalog file's text into items plus a report of what was dropped and why.
 *
 * @param {string} text the decoded file (a UTF-8 BOM is tolerated)
 * @returns {{items: Array<object>, stats: {rows:number, kept:number, repaired:number,
 *   noBarcode:number, badBarcode:number, duplicate:number, columns: string[]}}}
 */
export function parseCatalogFile(text) {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '');
  const stats = { rows: 0, kept: 0, repaired: 0, noBarcode: 0, badBarcode: 0, duplicate: 0, columns: [] };
  if (lines.length < 2) return { items: [], stats };

  const delimiter = detectDelimiter(lines[0]);
  const headers = splitLine(lines[0], delimiter).map((h) => HEADERS[headerKey(h)] || null);
  stats.columns = headers.filter(Boolean);
  if (!headers.includes('barcode') || !headers.includes('name')) {
    return { items: [], stats };
  }

  const items = [];
  const seen = new Set();
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i], delimiter);
    stats.rows++;
    const rec = {};
    headers.forEach((field, col) => {
      if (field) rec[field] = cells[col];
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
      retailPrice: toAgorotFromNumber(num(rec.retailPrice)),
    });
    stats.kept++;
  }
  return { items, stats };
}
