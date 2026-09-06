// israeli-bank-scrapers → AP Control's bank_transactions shape.
//
// Pure functions only — no browser, no network, no DB. The scraper library logs into the bank's
// own website and hands back per-account transaction arrays; everything this file knows about that
// shape lives here so the runner stays a thin script and the format is unit-tested.
//
// Sign convention matches Financy and the CSV importer: `chargedAmount` is already signed, a debit
// (a cleared check, a card charge) is NEGATIVE. Passed through untouched.

/** Shekels → integer agorot, rounding away float dust (11.7 → 1170, not 1169). */
function shekelsToAgorot(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

/**
 * The provider's row id, namespaced so it can never collide with Financy's `SK` on the same
 * account. `identifier` is the bank's own transaction id — for a check row it is the CHECK NUMBER,
 * which is also what lands in raw_reference and drives deterministic matching.
 *
 * Returns null when the institution reports no identifier (common on credit-card feeds). A null
 * external_id falls back to importTransactions' field-equality dedupe, which is the conservative
 * choice for a re-scraped window: it can merge two genuinely identical same-day charges, but it
 * never duplicates one.
 */
export function scrapedExternalId({ companyId, accountNumber, identifier }) {
  const id = identifier == null ? '' : String(identifier).trim();
  if (!id) return null;
  return `scr:${companyId || '?'}:${accountNumber || '?'}:${id}`;
}

/**
 * Map one scraped transaction to our bank_transactions shape.
 * @param {{date:string, chargedAmount:number, originalAmount?:number, description?:string, memo?:string, identifier?:(string|number), status?:string}} txn
 * @param {{companyId?:string, accountNumber?:string}} [ctx] institution + account, for the external id
 */
export function mapScrapedTransaction(txn, ctx = {}) {
  const amount = shekelsToAgorot(txn?.chargedAmount != null ? txn.chargedAmount : txn?.originalAmount);
  const desc = [txn?.description, txn?.memo]
    .map((p) => String(p == null ? '' : p).trim())
    .filter(Boolean);
  const uniq = [...new Set(desc)];
  return {
    txnDate: String(txn?.date ?? '').slice(0, 10),
    amount,
    description: uniq.length ? uniq.join(' — ') : null,
    rawReference: txn?.identifier != null && String(txn.identifier).trim() !== '' ? String(txn.identifier) : null,
    status: txn?.status ?? null,
    externalId: scrapedExternalId({ ...ctx, identifier: txn?.identifier }),
  };
}

/**
 * Map a whole account's transactions, keeping only rows that are safe to import:
 * COMPLETED only (a pending row has no final amount and reappears later as a completed one under
 * its own identifier — importing both would double-count), and rows with a usable date and a
 * non-zero amount. `status` is dropped from the output: it was only ever a filter.
 */
export function mapScrapedTransactions(txns, ctx = {}) {
  const out = [];
  for (const t of txns || []) {
    const m = mapScrapedTransaction(t, ctx);
    if (m.status && m.status !== 'completed') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.txnDate)) continue;
    if (m.amount == null || m.amount === 0) continue;
    const { status, ...row } = m; // eslint-disable-line no-unused-vars
    out.push(row);
  }
  return out;
}
