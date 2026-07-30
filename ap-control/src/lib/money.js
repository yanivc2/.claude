// Money is handled as integer agorot everywhere in the domain layer.
// These helpers convert at the UI boundary only.

/**
 * Parse a user-entered shekel string/number into integer agorot.
 * Accepts "1,234.56", "1234.5", 1234, "" (=> 0). Rejects non-numeric input.
 * @param {string|number|null|undefined} value
 * @returns {number} agorot (integer, may be negative)
 */
export function toAgorot(value) {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`סכום לא תקין: "${value}"`);
  }
  // Round to avoid binary float drift (e.g. 19.99 * 100 = 1998.9999...).
  return Math.round(Number(normalized) * 100);
}

/**
 * Format integer agorot as a shekel string with two decimals, thousands separators.
 * @param {number} agorot
 * @returns {string} e.g. "1,234.56"
 */
export function fromAgorot(agorot) {
  const sign = agorot < 0 ? '-' : '';
  const abs = Math.abs(Math.round(agorot));
  const shekels = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, '0');
  const grouped = shekels.toLocaleString('en-US');
  return `${sign}${grouped}.${rem}`;
}

/** Format agorot as a display string with the ₪ symbol. */
export function formatIls(agorot) {
  return `₪${fromAgorot(agorot)}`;
}
