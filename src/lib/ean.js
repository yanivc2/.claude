// EAN/GTIN check-digit validation — pure, no I/O.
// Used to catch OCR digit-misreads in scanned invoice barcodes: an EAN-8/UPC-A/EAN-13/GTIN-14
// whose checksum fails was almost certainly read wrong from the photo.

/** Lengths that carry a GS1 mod-10 check digit. */
const GTIN_LENGTHS = new Set([8, 12, 13, 14]);

/**
 * Validate a GS1 check digit (EAN-8 / UPC-A / EAN-13 / GTIN-14).
 *
 * @param {string|number|null|undefined} code
 * @returns {boolean|null} true = checksum valid, false = checksum WRONG (likely misread),
 *   null = no verdict — not a GTIN shape (short supplier internal codes, letters, empty),
 *   which must never be flagged as an error.
 */
export function eanChecksumOk(code) {
  const s = code === null || code === undefined ? '' : String(code).trim();
  if (!/^\d+$/.test(s) || !GTIN_LENGTHS.has(s.length)) return null;

  // GS1 mod-10: from the RIGHTMOST digit (the check digit's neighbours), weights alternate
  // 3,1,3,1… — computing right-to-left makes one loop cover every supported length.
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = 4 - w) {
    sum += digits[i] * w;
  }
  return (10 - (sum % 10)) % 10 === check;
}
