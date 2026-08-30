// Resolve one invoice line against ONE supplier's own catalog. Pure: no I/O, no DB — the caller
// loads the supplier's rows and passes them in, exactly as the master-catalog path does.
//
// This is what makes a barcode-less invoice identifiable. Free-text name search is banned against
// the 80k-row קטלוג-על because it returns coincidences; here the search space is one supplier's
// 26-54 products, and the names are measured unique (0 collisions across all three real files).
// Same mechanism, completely different odds.
//
// ── The packaging trap ────────────────────────────────────────────────────────
//
// Every product in these catalogs exists twice: a קופסה (single pack) and a פאקט (10 of them, or
// 5 for rolling tobacco). They share a name and, at גלוברנדס, a מק"ט — only the barcode differs.
// So identifying the PRODUCT does not identify the LINE, and choosing wrong is a silent 10×
// error in unit cost that lands in the price history and stays there.
//
// Packaging therefore gets its own decision, and it is taken by VOTE rather than by priority:
//   · the description is decisively closer to one of the two catalog names
//   · the description contains the word פאקט or קופסה
//   · כ.בודד ÷ כמות equals one side's יח' אריזה
// All agreeing → decided. Disagreeing → a conflict a human resolves. Silent → both are offered.
//
// The last two are worth stating plainly. A line reading 5 פאקטים / 50 יחידות carries the ratio
// 10, which is exactly the פאקט's יח' אריזה: the invoice states the packaging without naming it.
// And a first-hit-wins ordering would get that line WRONG whenever the description is the bare
// product name — the name matches the קופסה exactly, the arithmetic says פאקט, and the answer is
// off by a factor of ten with the contradicting evidence sitting unread on the same line.

import { baseName, normalizeItemName, PACK_BOX, PACK_CARTON } from './supplierCatalogFile.js';

/** Word set of a name, for comparing a printed description against a catalog name. */
function tokens(s) {
  return new Set(
    normalizeItemName(s)
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

/** Character bigrams of a normalized name — the unit of the near-miss comparison below. */
function bigrams(s) {
  const t = normalizeItemName(s).replace(/ /g, '');
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/**
 * Dice coefficient over character bigrams: 1 = identical, 0 = nothing shared.
 *
 * Word-level overlap cannot see a one-letter misreading. `מרלברו גולד` against the catalog's
 * `מרלבורו גולד` shares only the word `גולד`, so it scores 0.33 on tokens — below any usable
 * floor — while on characters it scores ~0.85. That gap matters here more than anywhere else in
 * the app: for פיליפ מוריס and מוצרי איכות קנדים the name is the ONLY identifier the invoice
 * carries, so a name the model spelled slightly wrong is a line with no identity at all.
 */
function diceSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  let total = 0;
  let shared = 0;
  for (const n of A.values()) total += n;
  for (const [g, n] of B) {
    total += n;
    shared += Math.min(n, A.get(g) || 0);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}

// A fuzzy name match only stands when it is both good on its own and clearly better than the
// runner-up. These are deliberately stricter than the master-catalog ranker's (0.15/0.12): there,
// a wrong pick is one unrelated product among many offered; here the catalog is small and every
// candidate is plausible, so a near-tie is far likelier to be a genuine coin-flip.
//
// The score is the better of word overlap and character similarity. Character similarity catches
// the misspelling; word overlap catches a name written with extra or reordered words. Both are
// held to the same floor, and the floor is high — these catalogs are full of names that differ by
// one word (`מרלבורו גולד` / `מרלבורו גולד 100`), so a loose threshold would confidently pick the
// wrong tobacco.
const NAME_FLOOR = 0.72;
const NAME_MARGIN = 0.08;

// How much closer to one packaging's name the description must be before that counts as a vote.
// Measured on the real catalogs: a bare product name scores 1.00 against the קופסה row and ~0.83
// against the פאקט row (the extra word `פאקט` is four characters of difference), and a one-letter
// misreading scores 0.84 / 0.70. Both clear 0.10 comfortably; a genuinely uninformative
// description clears nothing.
const PACK_NAME_MARGIN = 0.1;

/**
 * Index one supplier's catalog rows for lookup. Built once per draft.
 * @param {object[]} rows supplier_catalog rows (barcode, name, name_norm, sku, pack_type, pack_units…)
 */
export function buildSupplierIndex(rows) {
  const byBarcode = new Map();
  const bySku = new Map();
  const byName = new Map();
  for (const row of rows || []) {
    const barcode = String(row.barcode ?? '').trim();
    if (barcode) byBarcode.set(barcode, row);
    const sku = String(row.sku ?? '').trim();
    if (sku) {
      if (!bySku.has(sku)) bySku.set(sku, []);
      bySku.get(sku).push(row);
    }
    const name = String(row.name_norm ?? row.nameNorm ?? '').trim();
    if (name) {
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(row);
    }
  }
  return { byBarcode, bySku, byName, rows: rows || [] };
}

/** יח' אריזה of a row, or null. */
function unitsOf(row) {
  const n = Number(row?.pack_units ?? row?.packUnits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 'קופסה' / 'פאקט' of a row, or null. */
function packOf(row) {
  return row?.pack_type ?? row?.packType ?? null;
}

/**
 * Pick which packaging of a product the line refers to. Never guesses.
 *
 * @param {object[]} group the product's rows (normally one קופסה and one פאקט)
 * @param {{name?: string|null, quantity?: number|null, unitQuantity?: number|null}} line
 * @returns {{row: object|null, by: string|null, conflict: boolean, reasons?: string[]}}
 */
export function resolvePack(group, { name = null, quantity = null, unitQuantity = null } = {}) {
  const rows = group || [];
  if (rows.length === 0) return { row: null, by: null, conflict: false };
  if (rows.length === 1) return { row: rows[0], by: 'only', conflict: false };

  // Every rule votes, and the votes are counted afterwards. Running them in priority order and
  // returning on the first hit looks equivalent and is not: a line reading `וינסטון כחול בוקס`
  // with 5 כמות and 50 כ.בודד matches the קופסה's name exactly AND carries the ratio 10, which is
  // the פאקט's. First-hit-wins would answer קופסה and be wrong by a factor of ten, with the
  // contradicting evidence sitting right there on the same line unread.
  /** @type {Array<{row: object, by: string}>} */
  const votes = [];

  // Which of the two catalog names is the description actually closer to? This settles the
  // ordinary case: the קופסה row is named `מרלבורו גולד` and the פאקט row `פאקט מרלבורו גולד`, so
  // a line reading plain `מרלבורו גולד` is identical to the one and a word short of the other.
  // Without this vote the commonest line on a פיליפ מוריס or קנדים invoice — a bare product name
  // — would carry no packaging evidence at all.
  //
  // Closeness rather than equality, because the same reasoning has to survive the near-miss that
  // got us here: `מרלברו גולד` is not equal to either name, but it is still much nearer the
  // קופסה's. Equality would answer only the lines that never needed fuzzy matching.
  const printed = normalizeItemName(name);
  if (printed) {
    const byName = rows
      .map((r) => ({ row: r, score: diceSimilarity(printed, r.name) }))
      .sort((a, b) => b.score - a.score);
    const [top, runner] = byName;
    if (top && top.score - (runner ? runner.score : 0) >= PACK_NAME_MARGIN) {
      votes.push({ row: top.row, by: top.score === 1 ? 'exact_name' : 'closest_name' });
    }
  }

  // The description names the packaging outright.
  const { pack } = baseName(name);
  if (pack) {
    const hit = rows.find((r) => packOf(r) === pack);
    if (hit) votes.push({ row: hit, by: 'name' });
  }

  // כ.בודד ÷ כמות is the יח' אריזה of exactly one side: 5 פאקטים / 50 יחידות gives 10, and 10 is
  // the פאקט's. The invoice states the packaging without naming it.
  const q = Number(quantity);
  const u = Number(unitQuantity);
  if (Number.isFinite(q) && q > 0 && Number.isFinite(u) && u > 0) {
    const ratio = u / q;
    const fits = rows.filter((r) => unitsOf(r) === ratio);
    if (fits.length === 1) votes.push({ row: fits[0], by: 'ratio' });
  }

  if (!votes.length) return { row: null, by: null, conflict: false };
  const distinct = [...new Set(votes.map((v) => v.row))];
  if (distinct.length > 1) {
    // The line contradicts itself. Guessing here is exactly the silent 10× error, so it goes to
    // a human with both readings named.
    return { row: null, by: null, conflict: true, reasons: votes.map((v) => v.by) };
  }
  return { row: distinct[0], by: votes.map((v) => v.by).join('+'), conflict: false };
}

/**
 * Resolve one extracted line against a supplier's catalog.
 *
 * Order is by certainty, and every step stops at the product; packaging is then decided
 * separately. Nothing here writes anything — like every other catalog path in this app, the
 * result is an OFFER the review screen makes to a human.
 *
 * @param {{barcode?: string|null, sku?: string|null, name?: string|null,
 *   quantity?: number|null, unitQuantity?: number|null}} line
 * @param {ReturnType<typeof buildSupplierIndex>} index
 * @returns {{row: object|null, method: 'barcode'|'sku'|'name'|'name_fuzzy'|null,
 *   product: object[], packBy: string|null, packAmbiguous: boolean, packConflict: boolean,
 *   candidates: object[]}}
 */
export function matchLine(line, index) {
  const empty = { row: null, method: null, product: [], packBy: null, packAmbiguous: false, packConflict: false, candidates: [] };
  if (!index || !index.rows.length) return empty;

  const barcode = String(line?.barcode ?? '').replace(/\D/g, '');
  const sku = String(line?.sku ?? '').replace(/\D/g, '');
  const printed = line?.name ?? null;

  // 1. a full barcode identifies the row outright — packaging included, nothing left to decide.
  if (barcode) {
    const hit = index.byBarcode.get(barcode);
    if (hit) return { ...empty, row: hit, method: 'barcode', product: [hit] };
  }

  // 2. the supplier's own item number (גלוברנדס "פריט"). It identifies the PRODUCT — at
  //    גלוברנדס all 54 מק"ט values cover both a קופסה and a פאקט — so packaging still has to be
  //    settled. The invoice may print it in either the barcode or the מק"ט column.
  for (const code of [sku, barcode]) {
    if (!code) continue;
    const group = index.bySku.get(code);
    if (group && group.length) {
      const { row, by, conflict } = resolvePack(group, { ...line, name: printed });
      return { row, method: 'sku', product: group, packBy: by, packAmbiguous: !row, packConflict: Boolean(conflict), candidates: group };
    }
  }

  // 3. the product name, which across all three real catalogs is a unique key once the packaging
  //    word is stripped.
  const { base } = baseName(printed);
  if (base) {
    const group = index.byName.get(base);
    if (group && group.length) {
      const { row, by, conflict } = resolvePack(group, { ...line, name: printed });
      return { row, method: 'name', product: group, packBy: by, packAmbiguous: !row, packConflict: Boolean(conflict), candidates: group };
    }

    // 4. …and when the reading differs slightly from the catalog spelling, the closest name —
    //    but only when it is decisively closest.
    const printedTokens = tokens(base);
    const scored = [...index.byName.entries()]
      .map(([name, group]) => ({
        name,
        group,
        score: Math.max(overlap(printedTokens, tokens(name)), diceSimilarity(base, name)),
      }))
      .sort((a, b) => b.score - a.score);
    const [best, next] = scored;
    if (best && best.score >= NAME_FLOOR && best.score - (next ? next.score : 0) >= NAME_MARGIN) {
      const { row, by, conflict } = resolvePack(best.group, { ...line, name: printed });
      return {
        row,
        method: 'name_fuzzy',
        product: best.group,
        packBy: by,
        packAmbiguous: !row,
        packConflict: Boolean(conflict),
        candidates: best.group,
      };
    }
    // Nothing decisive: hand back the nearest few for a human to choose from, best first.
    return { ...empty, candidates: scored.filter((s) => s.score > 0).slice(0, 5).flatMap((s) => s.group) };
  }

  return empty;
}

export { PACK_BOX, PACK_CARTON };
