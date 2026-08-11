// Matching a supplier name/tax-id read off an invoice against the suppliers table.
// Pure and deterministic — no I/O, no DB: the caller passes the supplier rows in.
// Israeli names arrive with gershayim ("בע\"מ"), assorted quote glyphs and OCR-ish typos,
// so everything is compared on a normalized form.

/** Quote/gershayim glyphs that carry no meaning for matching purposes. */
const QUOTES = /["'`´׳״‘’“”]/g;

/** Legal-form tokens dropped before comparing ("בע\"מ" normalizes to "בעמ"). */
const LEGAL_SUFFIXES = new Set(['בעמ', 'ltd', 'limited']);

/** Fuzzy candidates below this similarity are not a match at all. */
const FUZZY_THRESHOLD = 0.75;

/** Shortest normalized name allowed to win by containment (avoids "אב" matching everything). */
const MIN_CONTAINS_LEN = 4;

/**
 * Canonical comparison form of a supplier name: lowercase latin, no gershayim/quotes,
 * no punctuation, no legal suffix, single spaces.
 * @param {string|null|undefined} s
 * @returns {string} normalized name ('' when nothing meaningful is left)
 */
export function normalizeSupplierName(s) {
  if (s === null || s === undefined) return '';
  const stripped = String(s)
    .toLowerCase()
    .replace(QUOTES, '') // בע"מ → בעמ, ltd’s apostrophes, etc.
    .replace(/[^\p{L}\p{N}]+/gu, ' '); // punctuation (incl. "ltd.") → space
  return stripped
    .split(' ')
    .filter((w) => w && !LEGAL_SUFFIXES.has(w))
    .join(' ')
    .trim();
}

/** Digits only, for tax-id comparison ("51-123456-7" → "511234567"). */
function onlyDigits(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\D/g, '');
}

/** Dice coefficient over two token/bigram sets: 2|A∩B| / (|A|+|B|). */
function dice(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

/** Character bigrams of the name with spaces removed — tolerates typos inside a word. */
function bigrams(name) {
  const t = name.replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  if (t.length === 1) out.add(t);
  return out;
}

/**
 * Similarity of two normalized names, 0..1. Word-token Dice (catches reordered/extra words)
 * combined with character-bigram Dice (catches typos and missing letters).
 * @param {string} a normalized name
 * @param {string} b normalized name
 */
export function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const tokenScore = dice(new Set(a.split(' ')), new Set(b.split(' ')));
  const bigramScore = dice(bigrams(a), bigrams(b));
  return Math.max(tokenScore, bigramScore);
}

/** Round a score to 3 decimals so persisted drafts compare cleanly. */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Find the supplier row an extracted invoice header refers to.
 * Priority: tax id → exact normalized name → containment → fuzzy similarity.
 * @param {string|null|undefined} name supplier name as printed on the invoice
 * @param {string|null|undefined} taxId ח.פ. / ע.מ. as printed (any formatting)
 * @param {Array<{id:number, name:string, tax_id?:string|null}>} suppliers candidate rows
 * @returns {{supplier:object, score:number, method:'tax_id'|'exact'|'contains'|'fuzzy'}|null}
 */
export function matchSupplier(name, taxId, suppliers) {
  const rows = Array.isArray(suppliers) ? suppliers.filter(Boolean) : [];
  if (rows.length === 0) return null;

  // 1. Tax id is authoritative — an exact digit match beats any name similarity.
  const digits = onlyDigits(taxId);
  if (digits) {
    const hit = rows.find((r) => onlyDigits(r.tax_id) === digits);
    if (hit) return { supplier: hit, score: 1, method: 'tax_id' };
  }

  const target = normalizeSupplierName(name);
  if (!target) return null;

  const candidates = rows
    .map((r) => ({ row: r, norm: normalizeSupplierName(r.name) }))
    .filter((c) => c.norm);

  // 2. Same name after normalization.
  const exact = candidates.find((c) => c.norm === target);
  if (exact) return { supplier: exact.row, score: 1, method: 'exact' };

  // 3. One name contains the other (branch suffixes, truncated headers).
  if (target.length >= MIN_CONTAINS_LEN) {
    const contained = candidates.find(
      (c) =>
        c.norm.length >= MIN_CONTAINS_LEN &&
        (c.norm.includes(target) || target.includes(c.norm)),
    );
    if (contained) return { supplier: contained.row, score: 0.9, method: 'contains' };
  }

  // 4. Best fuzzy candidate above the threshold (first row wins ties — deterministic).
  let best = null;
  for (const c of candidates) {
    const score = nameSimilarity(target, c.norm);
    if (!best || score > best.score) best = { supplier: c.row, score };
  }
  if (best && best.score >= FUZZY_THRESHOLD) {
    return { supplier: best.supplier, score: round3(best.score), method: 'fuzzy' };
  }
  return null;
}
