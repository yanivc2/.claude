// Pure extraction of candidate invoice fields from OCR text. Best-effort heuristics for
// Israeli invoices — decision support only; a human always verifies. No I/O, fully testable
// without an OCR engine.

/** Remove gershayim/quote variants so labels like מע"מ match however OCR rendered them. */
function normalize(text) {
  return String(text || '').replace(/["'׳״`]/g, '');
}

/** Parse a money-like string ("1,234.56", "1234", "₪ 90.5") to integer agorot, or null. */
export function parseAmountToAgorot(str) {
  if (str == null) return null;
  const cleaned = String(str).replace(/[₪\s]/g, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** All money-like tokens (must have a decimal point or thousands grouping to avoid noise). */
export function findAmounts(text) {
  const t = normalize(text);
  const re = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}/g;
  const out = [];
  for (const m of t.matchAll(re)) {
    const agorot = parseAmountToAgorot(m[0]);
    if (agorot != null) out.push(agorot);
  }
  return [...new Set(out)].sort((a, b) => b - a);
}

/** First money token appearing shortly after any of the given (quote-free) labels. */
function amountNearLabel(normText, labels, span = 40) {
  for (const label of labels) {
    let from = 0;
    let idx;
    while ((idx = normText.indexOf(label, from)) !== -1) {
      const window = normText.slice(idx + label.length, idx + label.length + span);
      const m = window.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}/);
      if (m) {
        const agorot = parseAmountToAgorot(m[0]);
        if (agorot != null) return agorot;
      }
      from = idx + label.length;
    }
  }
  return null;
}

/** Nine-digit sequences (allocation numbers / tax ids), bounded so they aren't parts of longer runs. */
export function findNineDigits(text) {
  const t = normalize(text);
  const out = [];
  for (const m of t.matchAll(/(?<!\d)(\d{9})(?!\d)/g)) out.push(m[1]);
  return [...new Set(out)];
}

function findAllocation(normText) {
  const nines = findNineDigits(normText);
  if (nines.length === 0) return null;
  // Prefer a 9-digit number appearing near the word "הקצאה".
  const idx = normText.indexOf('הקצאה');
  if (idx !== -1) {
    const window = normText.slice(idx, idx + 60);
    const near = window.match(/(?<!\d)(\d{9})(?!\d)/);
    if (near) return near[1];
  }
  return nines[0];
}

/** VAT amount near "מעמ", skipping the "לפני מעמ" (pre-VAT) occurrence. */
function findVat(normText, span = 40) {
  let from = 0;
  let idx;
  while ((idx = normText.indexOf('מעמ', from)) !== -1) {
    const before = normText.slice(Math.max(0, idx - 6), idx);
    if (!/לפני\s*$/.test(before)) {
      const window = normText.slice(idx + 3, idx + 3 + span);
      const m = window.match(/\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}/);
      if (m) {
        const agorot = parseAmountToAgorot(m[0]);
        if (agorot != null) return agorot;
      }
    }
    from = idx + 3;
  }
  return null;
}

function findDate(text) {
  const t = normalize(text);
  // dd/mm/yyyy, dd.mm.yyyy, dd-mm-yyyy
  let m = t.match(/(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?!\d)/);
  if (m) {
    const [, d, mo, y] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // yyyy-mm-dd
  m = t.match(/(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/);
  if (m) {
    const [, y, mo, d] = m;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return null;
}

function findInvoiceNumber(normText) {
  for (const label of ['חשבונית מס', 'מספר חשבונית', 'חשבונית מספר', 'מס חשבונית', 'מספר', 'מס']) {
    const idx = normText.indexOf(label);
    if (idx !== -1) {
      const window = normText.slice(idx + label.length, idx + label.length + 20);
      const m = window.match(/(?<!\d)(\d{2,})(?!\d)/); // avoid single-digit noise
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Extract candidate fields from OCR raw text.
 * @returns {{allocationNumber:string|null, invoiceNumber:string|null, date:string|null,
 *   totalAmount:number|null, vatAmount:number|null, amountBeforeVat:number|null,
 *   amounts:number[], nineDigits:string[]}}  amounts in agorot
 */
export function extractFields(rawText) {
  const t = normalize(rawText);
  const amounts = findAmounts(t);

  const totalAmount =
    amountNearLabel(t, ['סהכ לתשלום', 'סה כ לתשלום', 'לתשלום', 'סהכ', 'סה כ', 'total']) ??
    (amounts.length ? amounts[0] : null);
  const vatAmount = findVat(t) ?? amountNearLabel(t, ['vat']);
  const amountBeforeVat =
    amountNearLabel(t, ['לפני מעמ', 'סכום ביניים', 'סכום לפני', 'subtotal']) ??
    (totalAmount != null && vatAmount != null ? totalAmount - vatAmount : null);

  return {
    allocationNumber: findAllocation(t),
    invoiceNumber: findInvoiceNumber(t),
    date: findDate(t),
    totalAmount,
    vatAmount,
    amountBeforeVat,
    amounts,
    nineDigits: findNineDigits(t),
  };
}
