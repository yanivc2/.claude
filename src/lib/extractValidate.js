// Validation + normalization of the raw Claude extraction JSON into the review draft.
// Pure: no I/O, no DB — the caller passes the supplier rows and the VAT rate in.
// Output money is integer agorot and ABSOLUTE; the sign is applied at commit time from docType.
// Nothing here rejects a document — every problem becomes a flag (for the review UI) and/or a
// Hebrew warning (for the human). A human always approves before anything is written.

import { fromAgorot, formatIls } from './money.js';
import { matchSupplier } from './supplierMatch.js';

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
 * @typedef {'no_supplier_match'|'fuzzy_match'|'missing'|'low_confidence'|'defaulted'
 *   |'invalid_format'|'vat_mismatch'|'vat_rate_off'|'lines_sum_mismatch'
 *   |'computed'|'computed_per_unit'|'missing_amounts'} FlagCode
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

/**
 * Normalize one extracted line. `unitCost` is always the price of ONE INDIVIDUAL item —
 * that is what the product catalog compares over time. When the line carries a separate
 * single-item count (כ.בודד) the price per item is line total / that count, not / quantity,
 * because the printed quantity is cartons for many suppliers.
 * An explicit unit_cost always wins, so a hand-typed correction is never overridden.
 */
function normalizeLine(raw, lineNo) {
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

  return {
    lineNo,
    name: str(src.name),
    barcode: str(src.barcode),
    sku: str(src.sku),
    quantity,
    unitQuantity,
    unitCost,
    unitCostSource,
    packCost,
    lineTotal,
    confidence,
    flags,
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
 * @param {{suppliers?: Array<object>, vatRate?: number}} [opts]
 * @returns {{header: object, lines: object[], flags: Record<string, string[]>,
 *   warnings: Array<{code: string, message: string}>, notes: string|null}}
 */
export function validateExtraction(extraction, { suppliers = [], vatRate = 0.18 } = {}) {
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
  const lines = rawLines.map((line, i) => normalizeLine(line, i + 1));

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
