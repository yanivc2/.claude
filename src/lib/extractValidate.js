// Validation + normalization of the raw Claude extraction JSON into the review draft.
// Pure: no I/O, no DB — the caller passes the supplier rows and the VAT rate in.
// Output money is integer agorot and ABSOLUTE; the sign is applied at commit time from docType.
// Nothing here rejects a document — every problem becomes a flag (for the review UI) and/or a
// Hebrew warning (for the human). A human always approves before anything is written.

import { fromAgorot, formatIls } from './money.js';
import { matchSupplier, normalizeSupplierName } from './supplierMatch.js';
import { eanChecksumOk } from './ean.js';

/**
 * Every flag code this module can emit.
 * Header flags (per field, in `flags`):
 *   'no_supplier_match' — no supplier row matched the extracted name/tax id
 *   'fuzzy_match'       — a supplier matched, but not with certainty (containment/fuzzy)
 *   'missing'           — a field required for commit came back empty
 *   'low_confidence'    — Claude reported low confidence for the field
 *   'defaulted'         — the value was unreadable and a default was assumed
 *   'invalid_format'    — the value did not match its required format and was dropped
 *   'vat_mismatch'      — before + VAT ≠ total
 *   'vat_rate_off'      — the implied VAT rate differs from the configured one
 *   'lines_sum_mismatch'— Σ line totals ≠ amount before VAT
 * Line flags (per line, in `lines[].flags`):
 *   'computed'          — unit cost was derived from line total / quantity
 *   'computed_per_unit' — unit cost was derived from line total / כ.בודד (single-item count)
 *   'missing_amounts'   — neither unit cost nor line total could be read
 *   'low_confidence'    — Claude reported low confidence for the line
 *   'catalog_match'     — the full barcode was found in the master catalog (identity confirmed)
 *   'catalog_suffix_match' — only a shortened code was printed and exactly one catalog barcode
 *                         ends with it (Tnuva prints `42435` for `7290000042435`) — offered,
 *                         never applied
 *   'catalog_ambiguous' — the shortened code matches several catalog barcodes; `candidates`
 *                         carries them for a human to pick from
 *   'barcode_invalid'   — GTIN checksum failed and no catalog hit — likely misread digits
 * @typedef {'no_supplier_match'|'fuzzy_match'|'missing'|'low_confidence'|'defaulted'
 *   |'invalid_format'|'vat_mismatch'|'vat_rate_off'|'lines_sum_mismatch'
 *   |'computed'|'computed_per_unit'|'missing_amounts'|'catalog_match'|'catalog_suffix_match'
 *   |'catalog_ambiguous'|'barcode_invalid'} FlagCode
 */
export const FLAG_CODES = Object.freeze([
  'no_supplier_match',
  'fuzzy_match',
  'missing',
  'low_confidence',
  'defaulted',
  'invalid_format',
  'vat_mismatch',
  'vat_rate_off',
  'lines_sum_mismatch',
  'computed',
  'computed_per_unit',
  'missing_amounts',
  'catalog_match',
  'catalog_suffix_match',
  'catalog_ambiguous',
  'barcode_invalid',
]);

/** Header fields that always appear as keys in the returned `flags` object. */
export const FLAG_FIELDS = Object.freeze([
  'supplier',
  'invoiceNumber',
  'allocationNumber',
  'invoiceDate',
  'docType',
  'amountBeforeVat',
  'vatAmount',
  'totalAmount',
  'linesSum',
]);

/** Document types we accept; anything else (incl. 'unknown') falls back to a tax invoice. */
const DOC_TYPES = new Set(['tax_invoice', 'tax_invoice_receipt', 'credit_note']);
const DEFAULT_DOC_TYPE = 'tax_invoice';

/** Fields that must be present before the draft can become an invoice. */
const REQUIRED_FIELDS = ['invoiceNumber', 'invoiceDate', 'amountBeforeVat', 'totalAmount'];

/** Hebrew labels for warning texts. */
const LABELS = {
  supplier: 'ספק',
  invoiceNumber: 'מספר חשבונית',
  allocationNumber: 'מספר הקצאה',
  invoiceDate: 'תאריך חשבונית',
  docType: 'סוג מסמך',
  amountBeforeVat: 'סכום לפני מע"מ',
  vatAmount: 'מע"מ',
  totalAmount: 'סה"כ לתשלום',
};

/** Extraction `field_confidence` keys → our flag field names. */
const CONFIDENCE_FIELDS = {
  supplier_name: 'supplier',
  invoice_number: 'invoiceNumber',
  allocation_number: 'allocationNumber',
  invoice_date: 'invoiceDate',
  amount_before_vat: 'amountBeforeVat',
  vat_amount: 'vatAmount',
  total_amount: 'totalAmount',
};

/** VAT math tolerance (agorot) — rounding on the supplier's side, not an error. */
const VAT_TOLERANCE_AGOROT = 100;
/** Implied-rate tolerance around the configured VAT rate. */
const VAT_RATE_TOLERANCE = 0.005;
/** Lines-sum tolerance: at least 1 ₪, or 0.5% of the pre-VAT amount when that is larger. */
const LINES_SUM_FLOOR_AGOROT = 100;
const LINES_SUM_RATIO = 0.005;

/**
 * Convert a decimal-shekel value from the model into integer agorot.
 * Accepts numbers and defensively numeric strings ("1,234.56", "₪ 90.5").
 * @param {number|string|null|undefined} n
 * @returns {number|null} agorot, or null when there is no usable number
 */
export function toAgorotFromNumber(n) {
  if (n === null || n === undefined) return null;
  let num;
  if (typeof n === 'number') {
    num = n;
  } else {
    const cleaned = String(n).replace(/[₪,\s]/g, '');
    if (cleaned === '') return null;
    num = Number(cleaned);
  }
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 100);
}

/** Agorot as an absolute value — signs come from docType at commit time. */
function absAgorot(value) {
  const agorot = toAgorotFromNumber(value);
  return agorot === null ? null : Math.abs(agorot);
}

/** Trimmed non-empty string, or null. */
function str(value) {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t === '' ? null : t;
}

/** Finite number, or null. */
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when the ISO string is a real calendar date (not 2026-02-30). */
function isRealIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Normalize an Israeli invoice date to YYYY-MM-DD.
 * Accepts YYYY-MM-DD as-is and converts DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY and their
 * 2-digit-year forms (26 → 2026). Anything else (or an impossible date) → null.
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
export function parseDateILS(value) {
  const s = str(value);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return isRealIsoDate(s) ? s : null;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (!m) return null;
  const [, d, mo, rawYear] = m;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  const iso = `${year}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isRealIsoDate(iso) ? iso : null;
}

/** Allocation numbers are exactly 9 digits (רשות המסים) or nothing at all. */
function parseAllocation(value) {
  const s = str(value);
  if (!s) return { value: null, invalid: false };
  const digits = s.replace(/\D/g, '');
  if (digits.length === 9) return { value: digits, invalid: false };
  return { value: null, invalid: true };
}

/** One of high/medium/low; anything unknown is treated as medium (neutral). */
function confidenceOf(value) {
  const s = str(value);
  return s === 'high' || s === 'medium' || s === 'low' ? s : 'medium';
}

/** Light name normalization for comparing an extracted name to the catalog's canonical one. */
function looseName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/["'`´׳״]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Word set of a name, for comparing a printed description against a catalog name. */
function tokens(s) {
  return new Set(
    looseName(s)
      .split(' ')
      .filter((w) => w.length > 1),
  );
}

/** Jaccard overlap of two token sets: 0 = nothing in common, 1 = identical. */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * A manufacturer name, or null when the column holds junk. 9,274 rows of the owner's catalog
 * carry the literal value `,` — treating that as a real manufacturer would let it "match" and,
 * worse, would make two candidates look distinguishable when they are not.
 */
function manufacturerOf(row) {
  const raw = row?.manufacturer_name ?? null;
  return raw && normalizeSupplierName(raw) ? raw : null;
}

/**
 * How confidently a printed short code identifies a product, measured on the owner's own
 * 80,411-item catalog:
 *
 *     code length   resolves to exactly one product
 *          5              64.5%
 *          6              94.3%
 *          7              99.4%
 *          8              99.9%
 *
 * So the same mechanism carries very different weight at 5 digits than at 8, and the review
 * screen should not present them identically. Below 7 it is a suggestion; at 7+ it is all but
 * certain. (The real Tnuva invoice prints six 5-digit codes and twenty-five 7-8 digit ones.)
 */
export const CODE_NEAR_CERTAIN_LEN = 7;

// Thresholds for picking between several catalog candidates for one shortened code. Set from the
// two genuinely ambiguous codes on the real Tnuva invoice, not by feel:
//
//   `42435` → {סט אוכל 12 חלקים, חלב דל שומן 1% · תנובה, קונפיטורה אפרסק}, printed "הומוגני 1% דל"
//   `43890` → {אצבעות אנטריקוט, כפפות ניטריל, רויון 1.5% · תנובה}, printed "רויון 1 ליטר"
//
// In both, the right answer scores 0.25-0.34 on name overlap and every wrong one scores exactly
// 0.00 — which is not luck: across the whole catalog, 97% of ambiguous groups hold products whose
// names have nothing in common (a wine, a six-pack, matzah and a food coupon share a code tail).
// So a real winner separates itself by a wide margin, and anything close is genuinely unclear.
const NAME_FLOOR = 0.15; // the winner must actually share words with what was printed
const NAME_MARGIN = 0.12; // …and clearly beat the runner-up
const SUPPLIER_BONUS = 0.35; // the candidate is made by the supplier who issued the invoice

/**
 * Rank catalog candidates for one printed code against what the line actually says.
 * Pure and exported for testing; returns the candidates best-first with their scores.
 *
 * **The supplier breaks ties; it does not outvote the description.** Measured on the owner's
 * 80,461-item catalog, for a 5-digit printed code:
 *
 *     43.2%  only one candidate anyway
 *     24.9%  several, and the supplier picks the right one
 *     0.05%  several, and even the supplier cannot separate them
 *     17.9%  ⚠ the RIGHT product has no manufacturer on file and a WRONG one does
 *
 * That last row is why the supplier is a tie-break and not a filter — and why its bonus must not
 * be able to beat a clear name match. The manufacturer column is populated for only 44.6% of the
 * catalog, so in ~18% of ambiguous 5-digit lookups the only candidate carrying the invoice's
 * supplier is the wrong one. A flat additive bonus of 0.35 would win those outright, because a
 * correct name match scores 0.25-0.34 on the real Tnuva invoice — the wrong product would be
 * adopted over the right one. So the bonus only applies among candidates whose name evidence is
 * effectively tied.
 *
 * @param {object[]} rows catalog rows sharing the printed code
 * @param {{printedName?: string|null, supplierName?: string|null}} context
 */
export function rankCandidates(rows, { printedName = null, supplierName = null } = {}) {
  const printed = tokens(printedName);
  const supplier = supplierName ? normalizeSupplierName(supplierName) : '';
  const scored = (rows || []).map((row) => {
    const manufacturer = manufacturerOf(row);
    const bySupplier = Boolean(supplier && manufacturer && normalizeSupplierName(manufacturer) === supplier);
    return { row, byName: overlap(printed, tokens(row.name)), bySupplier };
  });

  // The best name evidence anyone offers. A candidate is "in the running" only if its own name
  // evidence is within NAME_MARGIN of that — the supplier then separates whoever is left.
  const bestName = scored.reduce((m, c) => Math.max(m, c.byName), 0);
  for (const c of scored) {
    c.contested = c.byName >= bestName - NAME_MARGIN;
    c.score = c.byName + (c.bySupplier && c.contested ? SUPPLIER_BONUS : 0);
  }
  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Normalize one extracted line. `unitCost` is always the price of ONE INDIVIDUAL item —
 * that is what the product catalog compares over time. When the line carries a separate
 * single-item count (כ.בודד) the price per item is line total / that count, not / quantity,
 * because the printed quantity is cartons for many suppliers.
 * An explicit unit_cost always wins, so a hand-typed correction is never overridden.
 * `masterCatalog` (Map barcode→row, only this draft's codes) confirms product identity:
 * a hit attaches `line.catalog` and suppresses any checksum verdict; a checksum failure
 * without a hit flags a likely misread. Absence from the catalog alone is never an error —
 * it holds one chain's range, not the world.
 */
function normalizeLine(raw, lineNo, masterCatalog = null, supplierName = null) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const flags = [];
  const quantity = num(src.quantity);
  const unitQuantity = num(src.unit_quantity);
  const lineTotal = absAgorot(src.line_total);
  const singles = unitQuantity !== null && unitQuantity > 0 ? unitQuantity : null;
  const packs = quantity !== null && quantity > 0 ? quantity : null;
  const basis = singles ?? packs;
  let unitCost = absAgorot(src.unit_cost);
  let packCost = absAgorot(src.pack_cost);
  /** @type {'extracted'|'computed'|null} */
  let unitCostSource = null;

  if (unitCost !== null) {
    unitCostSource = 'extracted';
  } else if (basis !== null && lineTotal !== null) {
    unitCost = Math.round(lineTotal / basis);
    unitCostSource = 'computed';
    flags.push(singles !== null ? 'computed_per_unit' : 'computed');
  }
  // The carton price is only meaningful when the line really has two different bases.
  if (packCost === null && singles !== null && packs !== null && singles !== packs && lineTotal !== null) {
    packCost = Math.round(lineTotal / packs);
  }
  if (absAgorot(src.unit_cost) === null && lineTotal === null) flags.push('missing_amounts');

  const confidence = confidenceOf(src.confidence);
  if (confidence === 'low') flags.push('low_confidence');

  const name = str(src.name);
  const barcode = str(src.barcode);
  const sku = str(src.sku);
  const catalogInfo = (row, printedName) => ({
    name: row.name,
    manufacturer: manufacturerOf(row),
    quantity: num(row.quantity),
    unitQty: row.unit_qty ?? null,
    qtyInPackage: num(row.qty_in_package),
    nameDiffers: looseName(printedName) !== looseName(row.name),
  });

  // Identity, in order of certainty:
  //   1. the full barcode is printed and is in the catalog          → catalog_match
  //   2. only a SHORTENED code is printed (Tnuva prints `42435` for `7290000042435`), and one
  //      catalog barcode ends with it — or several do and one of them is clearly the product the
  //      line describes                                              → catalog_suffix_match
  //   3. several, with no clear winner                               → catalog_ambiguous, ranked
  // Nothing here overwrites what was extracted. Every hit is an offer the review screen makes to
  // a human, because a shortened code is a weaker claim than a printed 13-digit barcode.
  const exact = masterCatalog?.exact ?? masterCatalog; // plain Map: older callers pass one directly
  const byCode = masterCatalog?.byCode ?? null;
  let catalog = null;
  let candidates = null;

  const hit = barcode ? (exact?.get?.(barcode) ?? null) : null;
  if (hit) {
    flags.push('catalog_match');
    catalog = catalogInfo(hit, name);
  } else {
    // The shortened code turns up in the barcode column as often as in the מק"ט column.
    let printedCode = null;
    const found = [barcode, sku].reduce((acc, code) => {
      if (acc || !code) return acc;
      const rows = byCode?.get?.(code) ?? null;
      if (rows) printedCode = code;
      return rows;
    }, null);
    const adopt = (row, ranked) => ({
      ...catalogInfo(row, name),
      barcode: row.barcode,
      codeLen: printedCode ? printedCode.length : null,
      // Near-certain at 7+ digits (99.4% of codes that long resolve to one product), a suggestion
      // below that. The review screen words the badge from this rather than guessing.
      nearCertain: Boolean(printedCode && printedCode.length >= CODE_NEAR_CERTAIN_LEN),
      ...(ranked ? { chosenBy: ranked.bySupplier ? 'supplier+name' : 'name' } : {}),
    });

    if (found && found.length === 1) {
      flags.push('catalog_suffix_match');
      catalog = adopt(found[0], null);
    } else if (found && found.length > 1) {
      const ranked = rankCandidates(found, { printedName: name, supplierName });
      const [best, next] = ranked;
      if (best.score >= NAME_FLOOR && best.score - (next ? next.score : 0) >= NAME_MARGIN) {
        // One candidate matches what the line actually describes; the rest are unrelated products
        // that happen to end in the same digits. Still an offer, never an automatic write.
        flags.push('catalog_suffix_match');
        catalog = adopt(best.row, best);
      } else {
        flags.push('catalog_ambiguous');
      }
      // Ranked either way: even when one is adopted, the alternatives stay visible in order, so
      // a human correcting a bad pick sees the runner-up first instead of an arbitrary list.
      candidates = ranked.slice(0, 6).map((c) => ({ ...catalogInfo(c.row, name), barcode: c.row.barcode }));
    } else if (barcode && eanChecksumOk(barcode) === false) {
      flags.push('barcode_invalid');
    }
  }

  return {
    lineNo,
    name,
    barcode,
    sku,
    quantity,
    unitQuantity,
    unitCost,
    unitCostSource,
    packCost,
    lineTotal,
    confidence,
    flags,
    catalog,
    candidates,
  };
}

/**
 * Validate + normalize a parsed Claude extraction into the review draft shape.
 * The returned object is the contract persisted as `invoice_drafts.normalized` and rendered
 * by the review screen: money in agorot (absolute), flags per header field, Hebrew warnings.
 *
 * `header.supplierName` is the name as printed on the document (not the matched supplier's
 * canonical name) — `supplierId` / `supplierScore` / `supplierMethod` describe the match.
 *
 * @param {object|null} extraction parsed model JSON (see EXTRACTION_SCHEMA)
 * @param {{suppliers?: Array<object>, vatRate?: number,
 *   masterCatalog?: Map<string, object>|null}} [opts] masterCatalog holds ONLY the barcodes
 *   of this draft (the caller queries them) — the validator stays pure and offline-testable.
 * @returns {{header: object, lines: object[], flags: Record<string, string[]>,
 *   warnings: Array<{code: string, message: string}>, notes: string|null}}
 */
export function validateExtraction(extraction, { suppliers = [], vatRate = 0.18, masterCatalog = null } = {}) {
  const src = extraction && typeof extraction === 'object' ? extraction : {};
  const flags = {};
  for (const f of FLAG_FIELDS) flags[f] = [];
  /** @type {Array<{code: string, message: string}>} */
  const warnings = [];
  const addFlag = (field, code) => {
    if (flags[field] && !flags[field].includes(code)) flags[field].push(code);
  };
  const warn = (code, message) => warnings.push({ code, message });

  // --- ספק ---------------------------------------------------------------------
  const supplierName = str(src.supplier_name);
  const supplierTaxId = str(src.supplier_tax_id);
  const supplierPhone = str(src.supplier_phone);
  const match = matchSupplier(supplierName, supplierTaxId, suppliers);
  if (!match) {
    addFlag('supplier', 'no_supplier_match');
    warn(
      'no_supplier_match',
      `לא נמצא ספק מתאים לשם "${supplierName ?? '—'}" — יש לבחור ספק ידנית.`,
    );
  } else if (match.score < 1 || (match.method !== 'tax_id' && match.method !== 'exact')) {
    addFlag('supplier', 'fuzzy_match');
    warn(
      'fuzzy_match',
      `התאמת ספק לא ודאית: "${supplierName ?? '—'}" זוהה כ"${match.supplier.name}" ` +
        `(${Math.round(match.score * 100)}%) — יש לוודא.`,
    );
  }

  // --- שדות כותרת --------------------------------------------------------------
  const invoiceNumber = str(src.invoice_number);

  const allocation = parseAllocation(src.allocation_number);
  if (allocation.invalid) {
    addFlag('allocationNumber', 'invalid_format');
    warn(
      'invalid_format',
      `מספר הקצאה שנקרא ("${str(src.allocation_number)}") אינו 9 ספרות — הושמט, יש להזין ידנית.`,
    );
  }

  const invoiceDate = parseDateILS(src.invoice_date);

  let docType = str(src.doc_type);
  if (!docType || !DOC_TYPES.has(docType)) {
    docType = DEFAULT_DOC_TYPE;
    addFlag('docType', 'defaulted');
    warn('defaulted', 'סוג המסמך לא זוהה — הוגדר כברירת מחדל "חשבונית מס". יש לוודא.');
  }

  const amountBeforeVat = absAgorot(src.amount_before_vat);
  const vatAmount = absAgorot(src.vat_amount);
  const totalAmount = absAgorot(src.total_amount);

  const header = {
    supplierId: match ? (match.supplier.id ?? null) : null,
    supplierName,
    supplierScore: match ? match.score : null,
    supplierMethod: match ? match.method : null,
    supplierTaxId,
    supplierPhone,
    invoiceNumber,
    allocationNumber: allocation.value,
    invoiceDate,
    docType,
    amountBeforeVat,
    vatAmount,
    totalAmount,
  };

  // --- שדות חובה חסרים ---------------------------------------------------------
  for (const field of REQUIRED_FIELDS) {
    if (header[field] === null) {
      addFlag(field, 'missing');
      warn('missing', `שדה חובה חסר: ${LABELS[field]} — יש להשלים לפני אישור.`);
    }
  }

  // --- רמת ודאות של המודל ------------------------------------------------------
  const fieldConfidence =
    src.field_confidence && typeof src.field_confidence === 'object' ? src.field_confidence : {};
  const lowFields = [];
  for (const [key, field] of Object.entries(CONFIDENCE_FIELDS)) {
    if (confidenceOf(fieldConfidence[key]) === 'low') {
      addFlag(field, 'low_confidence');
      lowFields.push(LABELS[field]);
    }
  }
  if (lowFields.length) {
    warn('low_confidence', `שדות שנקראו בוודאות נמוכה: ${lowFields.join(', ')} — יש לבדוק.`);
  }

  // --- שורות -------------------------------------------------------------------
  const rawLines = Array.isArray(src.lines) ? src.lines : [];
  // The supplier goes in so a shortened code can be resolved by who made the product:
  // prefer the matched supplier's canonical name, falling back to what was printed.
  const lineSupplier = (match && match.supplier && match.supplier.name) || supplierName;
  const lines = rawLines.map((line, i) => normalizeLine(line, i + 1, masterCatalog, lineSupplier));

  // ברקוד עם ספרת ביקורת שגויה וללא התאמת קטלוג — כנראה קריאה שגויה מהצילום.
  // אזהרה מרוכזת אחת; catalog_match לא מייצר אזהרה — האישור מוצג ברמת השורה בלבד.
  const badBarcodes = lines.filter((l) => l.flags.includes('barcode_invalid')).map((l) => l.lineNo);
  if (badBarcodes.length) {
    warn(
      'barcode_invalid',
      `ברקוד עם ספרת ביקורת שגויה בשורות ${badBarcodes.join(', ')} — ` +
        'ככל הנראה נקרא שגוי מהצילום; השוו לצילום ותקנו.',
    );
  }

  // --- בדיקת מע"מ --------------------------------------------------------------
  if (amountBeforeVat !== null && vatAmount !== null && totalAmount !== null) {
    const diff = Math.abs(amountBeforeVat + vatAmount - totalAmount);
    if (diff > VAT_TOLERANCE_AGOROT) {
      for (const f of ['amountBeforeVat', 'vatAmount', 'totalAmount']) addFlag(f, 'vat_mismatch');
      warn(
        'vat_mismatch',
        `סכום לפני מע"מ + מע"מ אינו שווה לסה"כ — הפרש של ${formatIls(diff)}.`,
      );
    }
  }
  if (amountBeforeVat !== null && amountBeforeVat > 0 && vatAmount !== null) {
    const implied = vatAmount / amountBeforeVat;
    if (Math.abs(implied - vatRate) > VAT_RATE_TOLERANCE) {
      addFlag('vatAmount', 'vat_rate_off');
      warn(
        'vat_rate_off',
        `שיעור המע"מ המחושב הוא ${(implied * 100).toFixed(2)}% במקום ` +
          `${(vatRate * 100).toFixed(2)}% — יש לבדוק.`,
      );
    }
  }

  // --- סכום השורות מול הכותרת --------------------------------------------------
  const withTotals = lines.filter((l) => l.lineTotal !== null);
  if (withTotals.length > 0 && amountBeforeVat !== null) {
    const linesSum = withTotals.reduce((acc, l) => acc + l.lineTotal, 0);
    const tolerance = Math.max(
      LINES_SUM_FLOOR_AGOROT,
      Math.round(LINES_SUM_RATIO * amountBeforeVat),
    );
    if (Math.abs(linesSum - amountBeforeVat) > tolerance) {
      addFlag('linesSum', 'lines_sum_mismatch');
      warn(
        'lines_sum_mismatch',
        `סכום השורות (${fromAgorot(linesSum)} ₪) אינו תואם לסכום לפני מע"מ ` +
          `(${fromAgorot(amountBeforeVat)} ₪) — יש לבדוק את השורות.`,
      );
    }
  }

  return { header, lines, flags, warnings, notes: str(src.notes) };
}
