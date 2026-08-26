// Multi-term search helpers. A search box may hold several values at once — invoice numbers,
// check numbers, etc. — separated by spaces, commas, semicolons or newlines. We match a row when
// it matches ANY of the terms (OR), so pasting a list finds them all in one search.

/** Split a raw query into distinct, trimmed terms (deduped, capped). '' → []. */
export function parseSearchTerms(q, max = 25) {
  return [...new Set(String(q ?? '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))].slice(0, max);
}

/**
 * Build an OR clause matching any term against any of the columns:
 *   ((colA LIKE ? OR colB LIKE ?) OR (colA LIKE ? OR colB LIKE ?) …)
 * Returns { sql, params }. Empty terms → { sql:'', params:[] } (caller should short-circuit).
 */
export function anyTermLike(terms, columns) {
  if (!terms.length || !columns.length) return { sql: '', params: [] };
  const perTerm = `(${columns.map((c) => `${c} LIKE ?`).join(' OR ')})`;
  const params = [];
  for (const t of terms) for (let i = 0; i < columns.length; i++) params.push(`%${t}%`);
  return { sql: `(${terms.map(() => perTerm).join(' OR ')})`, params };
}
