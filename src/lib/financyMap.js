// Financy / open-finance.ai (Israeli Open Banking) → AP Control's bank_transactions shape.
//
// Pure functions only — no network. Everything this file knows about the provider's JSON is
// derived from the published OpenAPI schema of `GET /v2/data/transactions` and
// `GET /v2/data/accounts` (docs.open-finance.ai). Keeping the mapping here means the API client
// stays a thin fetch wrapper and the format knowledge is unit-tested.
//
// Sign convention: the provider sends `amount.chargedAmount.amount` already signed — a debit
// (money leaving the account, e.g. a cleared check) is NEGATIVE. That is exactly what the
// reconciliation engine expects, so the sign is passed through untouched.

/** Shekels (a JS number from the API) → integer agorot. Guards float dust: 11.7 → 1170, not 1169. */
function shekelsToAgorot(n) {
  if (n == null || n === '') return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

/** Any provider date field → 'YYYY-MM-DD' (they send ISO dates, sometimes with a time suffix). */
function isoDate(value) {
  const s = String(value || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/**
 * The date the money actually moved. valueDate is the bank's own value date (what appears on the
 * statement line and what a check clears on); bookingDate/transactionDate are the fallbacks.
 */
export function financyTxnDate(t) {
  const d = t?.date || {};
  return isoDate(d.valueDate) || isoDate(d.bookingDate) || isoDate(d.transactionDate) || isoDate(t?.valueDate);
}

/**
 * Human description for the statement line. The provider splits it across a few fields; join the
 * ones that carry signal, de-duplicated, in the same "a — b" style the CSV importer produces.
 */
export function financyDescription(t) {
  const parts = [
    t?.description?.description,
    t?.merchantName,
    t?.description?.additionalInfo,
    t?.details,
  ]
    .map((p) => String(p == null ? '' : p).trim())
    .filter(Boolean);
  const seen = new Set();
  const uniq = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return uniq.length ? uniq.join(' — ') : null;
}

/**
 * The אסמכתא. `entryReference` is the reference the bank itself put on the line — for a check row
 * that is the CHECK NUMBER, which is what makes deterministic matching possible (findCandidates
 * reads raw_reference). `code` is the provider's transaction-type code, a weaker fallback.
 */
export function financyReference(t) {
  const ref = String(t?.entryReference ?? '').trim();
  if (ref) return ref;
  const code = String(t?.code ?? '').trim();
  return code || null;
}

/**
 * A settled (booked) transaction? A PENDING line has no final amount or value date and would
 * later reappear as a booked line under a different id — importing it would double-count.
 * The provider is not consistent about casing, and older rows may carry no status at all
 * (treated as booked, since that is what a missing status has always meant on this feed).
 */
export function isBookedFinancyTxn(t) {
  const status = String(t?.status ?? '').trim().toUpperCase();
  if (!status) return true;
  return status !== 'PENDING' && status !== 'DELETED' && status !== 'REJECTED';
}

/**
 * One provider transaction → one importTransactions() row, or null when the line must be skipped.
 * Skips: pending/deleted lines, the provider's own duplicates (the same charge seen through both
 * the bank and the card issuer), rows with no usable date or amount, and zero-amount rows
 * (balance-only markers — the CSV importer skips those too).
 */
export function mapFinancyTransaction(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.isDuplicate === true) return null;
  if (!isBookedFinancyTxn(t)) return null;

  const txnDate = financyTxnDate(t);
  if (!txnDate) return null;

  const charged = t.amount?.chargedAmount?.amount;
  const original = t.amount?.originalAmount?.amount;
  const amount = shekelsToAgorot(charged != null ? charged : original);
  if (amount == null || amount === 0) return null;

  const externalId = String(t.SK ?? t.id ?? '').trim() || null;

  return {
    txnDate,
    amount,
    description: financyDescription(t),
    rawReference: financyReference(t),
    balanceAfter: shekelsToAgorot(t.balancePerEndDay),
    externalId,
  };
}

/** Map a page of provider transactions, dropping the ones that must be skipped. */
export function mapFinancyTransactions(items) {
  return (items || []).map(mapFinancyTransaction).filter(Boolean);
}

/** Digits only, leading zeros stripped — '00123' and '123' are the same branch/account. */
function digits(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.replace(/^0+(?=\d)/, '');
}

/**
 * Which Financy account is this AP Control bank account? Matched on branch + account number
 * (`parsedAccount` on the provider's account object, `accountNumber` as the fallback), so the
 * owner never has to copy an opaque id by hand.
 * @returns {object|null} the single matching provider account, or null when there is no
 *   unambiguous match (none, or more than one — never guess which account to pull money data from)
 */
export function matchFinancyAccount(financyAccounts, bankAccount) {
  const wantBranch = digits(bankAccount?.branch);
  const wantNumber = digits(bankAccount?.account_number ?? bankAccount?.accountNumber);
  if (!wantNumber) return null;

  const hits = (financyAccounts || []).filter((a) => {
    const num = digits(a?.parsedAccount?.number ?? a?.accountNumber);
    if (!num || num !== wantNumber) return false;
    const branch = digits(a?.parsedAccount?.branch);
    // A provider that doesn't report a branch still matches on the account number alone;
    // when it does report one it has to agree.
    return !branch || !wantBranch || branch === wantBranch;
  });
  return hits.length === 1 ? hits[0] : null;
}
