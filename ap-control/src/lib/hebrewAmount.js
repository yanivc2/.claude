// Convert an amount (agorot) to Hebrew words for check printing (stage 4).
// Shekels are masculine; agorot are written as a /100 fraction, matching common Israeli
// check practice ("... שקלים חדשים ו-70/100 בלבד"). Supports 0..999,999 shekels.
//
// 🔴 Draft aid — have a native speaker review before any real check issuance (§11.5).

const ONES_M = ['', 'אחד', 'שניים', 'שלושה', 'ארבעה', 'חמישה', 'שישה', 'שבעה', 'שמונה', 'תשעה'];
const TEENS_M = [
  'עשרה', 'אחד עשר', 'שנים עשר', 'שלושה עשר', 'ארבעה עשר',
  'חמישה עשר', 'שישה עשר', 'שבעה עשר', 'שמונה עשר', 'תשעה עשר',
];
const TENS = ['', '', 'עשרים', 'שלושים', 'ארבעים', 'חמישים', 'שישים', 'שבעים', 'שמונים', 'תשעים'];
const HUNDREDS = ['', 'מאה', 'מאתיים', 'שלוש מאות', 'ארבע מאות', 'חמש מאות', 'שש מאות', 'שבע מאות', 'שמונה מאות', 'תשע מאות'];
const THOUSANDS_SMALL = ['', 'אלף', 'אלפיים', 'שלושת אלפים', 'ארבעת אלפים', 'חמשת אלפים', 'ששת אלפים', 'שבעת אלפים', 'שמונת אלפים', 'תשעת אלפים'];

/** Two-digit group 0..99 (masculine). */
function twoDigits(n) {
  if (n < 10) return ONES_M[n];
  if (n < 20) return TEENS_M[n - 10];
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u ? `${TENS[t]} ו${ONES_M[u]}` : TENS[t];
}

/** Group 0..999 as an array of word components. */
function subThousand(n) {
  const comps = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) comps.push(HUNDREDS[h]);
  if (r) comps.push(twoDigits(r));
  return comps;
}

/** Thousands prefix for th 1..999. */
function thousands(th) {
  if (th <= 9) return THOUSANDS_SMALL[th];
  if (th === 10) return 'עשרת אלפים';
  return `${subThousand(th).join(' ')} אלף`;
}

/** Join components inserting the vav before the final standalone word. */
function joinWithVav(comps) {
  const parts = comps.filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const last = parts[parts.length - 1];
  // If the last component already carries an internal "ו" (e.g. "עשרים ואחד"), don't double it.
  const prefixed = last.includes(' ו') ? last : `ו${last}`;
  return [...parts.slice(0, -1), prefixed].join(' ');
}

/** Whole shekels (0..999,999) to Hebrew words. */
export function shekelsToWords(n) {
  if (n === 0) return 'אפס';
  const th = Math.floor(n / 1000);
  const rem = n % 1000;
  const comps = [];
  if (th) comps.push(thousands(th));
  comps.push(...subThousand(rem));
  return joinWithVav(comps);
}

/**
 * Full check amount in words from agorot.
 * @param {number} agorot
 * @returns {string} e.g. "אלף מאה ושבעים שקלים חדשים בלבד"
 */
export function amountToHebrewWords(agorot) {
  const abs = Math.abs(Math.round(agorot));
  const shekels = Math.floor(abs / 100);
  const ag = abs % 100;
  const words = shekelsToWords(shekels);
  const agPart = ag > 0 ? ` ו-${String(ag).padStart(2, '0')}/100` : '';
  return `${words} שקלים חדשים${agPart} בלבד`;
}
