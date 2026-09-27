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
export function scrapedExternalId({ companyId, accountNumber, identifier, date = null, amount = null }) {
  const id = identifier == null ? '' : String(identifier).trim();
  if (!id) return null;
  // 🔴 אסמכתא לבדה אינה ייחודית בפועל (הפועלים חוזר על referenceNumber בין תנועות שונות), והמזהה
  // משמש לזיהוי כפילות — אסמכתא חוזרת הייתה מדלגת בשקט על תנועה אמיתית. תאריך + סכום מצמצמים את זה.
  const tail = date || amount != null ? `:${date || ''}:${amount ?? ''}` : '';
  return `scr:${companyId || '?'}:${accountNumber || '?'}:${id}${tail}`;
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
  const txnDate = String(txn?.date ?? '').slice(0, 10);
  return {
    txnDate,
    amount,
    description: uniq.length ? uniq.join(' — ') : null,
    rawReference: txn?.identifier != null && String(txn.identifier).trim() !== '' ? String(txn.identifier) : null,
    status: txn?.status ?? null,
    externalId: scrapedExternalId({ ...ctx, identifier: txn?.identifier, date: txnDate, amount }),
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

/**
 * מיפוי חשבון שנסרק לחשבון הבנק הרשום באפליקציה — **בלי לנחש**.
 *
 * 🔴 שני מרחבי כתיבה שונים: ייבוא CSV ו-Financy מוסרים מספר חשבון בלבד ("432110"), אבל סקרייפר
 * של בנק מוסר מזהה מלא — `בנק-סניף-חשבון` ("12-628-432110"), כי זה מה שה-API של הבנק דורש.
 * ההשוואה הקודמת הסירה תווים שאינם ספרות משני הצדדים, ולכן השוותה "12628432110" מול "432110"
 * ו**לא התאימה כלום**: כל חשבון שנסרק היה חוזר כ"לא מזוהה" ושום תנועה לא הייתה נקלטת.
 *
 * הסדר: התאמה מלאה → סניף+חשבון → מספר חשבון לבדו, **ורק אם הוא ייחודי**. שני חשבונות באותו
 * מספר בסניפים שונים = דו-משמעות, וזה מדווח ולא מנוחש (אותו כלל של `matchFinancyAccount`:
 * לעולם לא לנחש לאיזה ספר כסף נכנס).
 */
export function resolveScrapedAccount(rows) {
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  const byFull = new Map();
  const byBranchAccount = new Map();
  const countByAccount = new Map();
  for (const r of rows) {
    const acct = digits(r.account_number);
    byFull.set(acct, r);
    byBranchAccount.set(`${digits(r.branch)}|${acct}`, r);
    countByAccount.set(acct, (countByAccount.get(acct) || 0) + 1);
  }
  return (incoming) => {
    const raw = String(incoming ?? '');
    if (!raw.trim()) return null;
    const exact = byFull.get(digits(raw));
    if (exact) return exact;
    const parts = raw.split(/[^0-9]+/).filter(Boolean);
    if (parts.length >= 2) {
      const account = parts[parts.length - 1];
      const branch = parts[parts.length - 2];
      const hit = byBranchAccount.get(`${branch}|${account}`);
      if (hit) return hit;
      if (countByAccount.get(account) === 1) return byFull.get(account);
    }
    return null;
  };
}
