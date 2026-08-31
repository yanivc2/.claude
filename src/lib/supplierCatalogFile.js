// Parse a catalog the SUPPLIER itself supplies — the file a tobacco distributor hands over listing
// exactly what it sells us. Pure: no I/O, no DB. Sibling of catalogFile.js, which parses the
// public price-transparency קטלוג-על; this one is scoped to one supplier and is what makes an
// invoice WITHOUT barcodes identifiable at all.
//
// Measured on the three real files (מוצרי איכות קנדים 51 rows, פיליפ מוריס 94, גלוברנדס 108),
// two facts decide the whole design:
//
// 1. **A product is two rows, not one.** Every item ships as a קופסה (single pack) and as a
//    פאקט (a carton of 10, or 5 for rolling tobacco), each with its own barcode, and the names
//    differ only by a leading "פאקט". On the גלוברנדס file all 54 מק"ט values map to exactly
//    {פאקט+קופסה} — the item number identifies the PRODUCT and says nothing about the packaging.
//
//    This is the expensive half. Picking the wrong one of a pair is not a cosmetic error: it is
//    a 10× error in unit cost, landing silently in the product's price history. So packaging is
//    resolved as its own dimension and never guessed — see resolvePack() in
//    services/supplierCatalog.js.
//
// 2. **The base name is a unique key.** Strip that leading "פאקט" and, across all three files,
//    every base name maps to exactly one product: 0 collisions, 0 duplicate full names. That is
//    what makes name matching safe HERE while it stays banned against the 80k-row קטלוג-על —
//    the search space is one supplier's 50-110 items, not the world.
//
// Both גלוברנדס and דובק print a "פריט" column on their invoices. Measured on the גלוברנדס
// catalog, its מק"ט is 4 digits (108/108 filled, 54 distinct, range 6008-7060) — an assigned,
// tightly-clustered item number, NOT a shortened barcode. It is below MIN_SUFFIX_LEN, so the
// existing suffix matcher ignores it today; this file is what turns it into an identification.

import { eanChecksumOk } from './ean.js';
import { looksLikeXlsx, readXlsx } from './xlsxRead.js';

/**
 * Header aliases → our field names, matched on a squashed form so `מק"ט`, `מקט` and `מק ט` all
 * land on the same field. Unrecognised columns are ignored, so the owner never has to trim a
 * file before uploading it.
 */
const HEADERS = {
  ברקוד: 'barcode',
  barcode: 'barcode',
  שםמוצר: 'name',
  שם: 'name',
  name: 'name',
  מקט: 'sku',
  sku: 'sku',
  פריט: 'sku', // what the invoice calls it
  סוגאריזה: 'packType',
  יחאריזה: 'packUnits',
  יחידותבאריזה: 'packUnits',
  מותג: 'brand',
  משפחה: 'brand',
  קטגוריה: 'category',
  ברקודמקושר: 'linkedBarcode',
  יצרן: 'manufacturer',
  יצרןמקורי: 'originMaker',
};

/** The two packagings these catalogs use. */
export const PACK_BOX = 'קופסה';
export const PACK_CARTON = 'פאקט';

/** Squash a header for matching: drop quotes, apostrophes, spaces and punctuation. */
function headerKey(raw) {
  return String(raw || '')
    .replace(/^﻿/, '')
    .replace(/["'׳״.\-_\s]/g, '')
    .trim();
}

/**
 * Canonical comparison form of a product name. Same spirit as normalizeProductName in
 * services/products.js — nothing is dropped as a "legal suffix", every word of a product name
 * carries meaning.
 */
export function normalizeItemName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/["'`´׳״‘’“”]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * The product name with the packaging word removed — the key a product is identified by.
 * `פאקט מרלבורו אדום` and `מרלבורו אדום` are the same product in two boxes.
 *
 * The word is stripped wherever it appears rather than only at the start: the catalog always
 * prints it as a prefix, but an invoice line is free to write `מרלבורו אדום פאקט`.
 * @returns {{base: string, pack: 'קופסה'|'פאקט'|null}} pack = what the NAME claims, if anything
 */
export function baseName(s) {
  const norm = normalizeItemName(s);
  const words = norm.split(' ').filter(Boolean);
  const kept = words.filter((w) => w !== PACK_CARTON && w !== PACK_BOX);
  const pack = words.includes(PACK_CARTON) ? PACK_CARTON : words.includes(PACK_BOX) ? PACK_BOX : null;
  return { base: kept.join(' '), pack };
}

/** Trimmed non-empty string, or null. */
function str(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t === '' ? null : t;
}

/** Digits only, or null. */
function digits(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  return d === '' ? null : d;
}

/** Split one delimited line honouring RFC-4180 quoting — Hebrew names carry commas and quotes. */
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

/** Rows (array of arrays) from an .xlsx buffer or a CSV/TSV string. */
function toRows(input) {
  if (Buffer.isBuffer(input) && looksLikeXlsx(input)) return readXlsx(input);
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const delimiter = (lines[0].match(/\t/g) || []).length > (lines[0].match(/,/g) || []).length ? '\t' : ',';
  return lines.map((l) => splitLine(l, delimiter));
}

/**
 * Parse a supplier catalog into rows ready for import.
 *
 * Nothing is repaired silently. A barcode that fails its GTIN check digit is REJECTED, not
 * padded and hoped over: this file is about to become the answer to "which product is this",
 * and one transposed digit there is a wrong product adopted with full confidence. The
 * price-transparency importer repairs Excel-stripped leading zeros because it can CONFIRM the
 * repair with the checksum; here a bad code just means the file needs another look.
 *
 * @param {Buffer|string} input .xlsx buffer, or CSV/TSV text
 * @returns {{items: object[], warnings: string[], stats: object}}
 */
export function parseSupplierCatalog(input) {
  const rows = toRows(input);
  const warnings = [];
  if (!rows.length) return { items: [], warnings: ['הקובץ ריק.'], stats: { rows: 0, skipped: 0 } };

  const header = rows[0].map(headerKey);
  const map = {};
  header.forEach((h, i) => {
    const field = HEADERS[h];
    if (field && map[field] === undefined) map[field] = i;
  });

  // A header line that splits into fewer fields than the rows beneath it did not survive
  // parsing, and the damage is silent: every column after the break shifts by one, so the file
  // still yields the right NUMBER of rows with most of its columns quietly empty. The usual
  // cause is a bare double-quote in a Hebrew header — `מק"ט` written without doubling it, which
  // RFC-4180 reads as an opening quote that swallows the commas after it. Worth stating rather
  // than importing 108 rows with the packaging and the item number both blank.
  const widths = new Map();
  for (const row of rows.slice(1, 40)) {
    if (row && row.length) widths.set(row.length, (widths.get(row.length) || 0) + 1);
  }
  const modalWidth = [...widths.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? header.length;
  const headerBroken = header.length < modalWidth;
  if (map.barcode === undefined || map.name === undefined) {
    return {
      items: [],
      warnings: ['לא נמצאו עמודות "ברקוד" ו"שם מוצר" בשורת הכותרות.'],
      stats: { rows: 0, skipped: 0 },
    };
  }

  const at = (row, field) => (map[field] === undefined ? null : row[map[field]]);
  const items = [];
  const seen = new Set();
  let badBarcode = 0;
  let skipped = 0;

  for (const row of rows.slice(1)) {
    if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
    const barcode = digits(at(row, 'barcode'));
    const name = str(at(row, 'name'));
    if (!barcode || !name) {
      skipped++;
      continue;
    }
    if (eanChecksumOk(barcode) === false) {
      badBarcode++;
      skipped++;
      continue;
    }
    if (seen.has(barcode)) {
      skipped++;
      continue; // first occurrence wins
    }
    seen.add(barcode);

    const declaredPack = str(at(row, 'packType'));
    const { base, pack: packFromName } = baseName(name);
    // The סוג אריזה column is authoritative when the file has one; the name is the fallback.
    const packType = declaredPack || packFromName;
    const packUnitsRaw = Number(digits(at(row, 'packUnits')));
    const packUnits = Number.isFinite(packUnitsRaw) && packUnitsRaw > 0 ? packUnitsRaw : null;

    items.push({
      barcode,
      name,
      // The join key: both rows of a pair share it, and packType tells them apart.
      nameNorm: base,
      sku: digits(at(row, 'sku')),
      packType,
      packUnits,
      brand: str(at(row, 'brand')),
      category: str(at(row, 'category')),
      linkedBarcode: digits(at(row, 'linkedBarcode')),
      manufacturerName: str(at(row, 'manufacturer')),
    });
  }

  if (headerBroken) {
    warnings.push(
      `שורת הכותרות נקראה כ-${header.length} עמודות בזמן שהשורות עצמן מכילות ${modalWidth} — ` +
        'ככל הנראה יש גרש כפול בודד באחת הכותרות (למשל מק"ט). חלק מהעמודות לא ייקראו. ' +
        'מומלץ להעלות את הקובץ כ-XLSX.',
    );
  }
  if (badBarcode) {
    warnings.push(`${badBarcode} שורות נדחו — ספרת הביקורת של הברקוד שגויה. יש לבדוק את הקובץ.`);
  }
  if (!items.length) warnings.push('לא נמצאה אף שורה תקינה בקובץ.');

  // A base name that resolves to more than one PRODUCT (as opposed to the two packagings of one)
  // would break name matching, so it is surfaced at import rather than discovered at review time.
  const byBase = new Map();
  for (const it of items) {
    if (!byBase.has(it.nameNorm)) byBase.set(it.nameNorm, []);
    byBase.get(it.nameNorm).push(it);
  }
  const ambiguous = [...byBase.entries()].filter(
    ([, group]) => new Set(group.map((g) => g.packType)).size < group.length,
  );
  if (ambiguous.length) {
    warnings.push(
      `${ambiguous.length} שמות מופיעים יותר מפעם אחת באותה אריזה — התאמה לפי שם לא תוכל להכריע ביניהם ` +
        `(${ambiguous.slice(0, 3).map(([n]) => n).join(', ')}).`,
    );
  }

  return {
    items,
    warnings,
    stats: {
      rows: items.length,
      skipped,
      products: byBase.size,
      withSku: items.filter((i) => i.sku).length,
      cartons: items.filter((i) => i.packType === PACK_CARTON).length,
      boxes: items.filter((i) => i.packType === PACK_BOX).length,
    },
  };
}
