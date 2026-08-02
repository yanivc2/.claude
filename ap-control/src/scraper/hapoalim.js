// Stage 2 adapter for israeli-bank-scrapers (Bank Hapoalim). The library is a
// Puppeteer-based scraper (NOT an official API) and is an OPTIONAL dependency: it is
// loaded lazily so the core app installs and runs without it. Install it when ready:
//     npm install israeli-bank-scrapers
//
// 🔴 Before relying on this in production, verify against a real account (brief §11):
//   §11.1 — whether the scraped transaction text contains the check number (drives the
//           deterministic-match bonus; the R7 engine already works without it).
//   §11.2 — whether Hapoalim login works unattended with userCode+password (no interactive OTP).

/**
 * Map one scraped transaction to our bank_transactions shape. Pure — unit-testable
 * without the scraper library. Amount becomes signed integer agorot (debit negative),
 * matching chargedAmount's sign.
 *
 * @param {{date:string, chargedAmount:number, description?:string, memo?:string, identifier?:(string|number), status?:string}} txn
 */
export function mapScrapedTransaction(txn) {
  return {
    txnDate: String(txn.date).slice(0, 10),
    amount: Math.round(Number(txn.chargedAmount) * 100),
    description: txn.description ?? txn.memo ?? null,
    rawReference: txn.identifier != null ? String(txn.identifier) : null,
    status: txn.status ?? null,
  };
}

/**
 * Scrape Bank Hapoalim and return mapped transactions grouped by account number.
 * @param {{userCode:string, password:string, startDate:Date, showBrowser?:boolean}} opts
 * @returns {Promise<Array<{accountNumber:string, transactions:Array}>>}
 */
export async function scrapeHapoalim({ userCode, password, startDate, showBrowser = false }) {
  if (!userCode || !password) {
    throw new Error('חסרים פרטי התחברות לבנק (BANK_HAPOALIM_USER_CODE / BANK_HAPOALIM_PASSWORD)');
  }

  let lib;
  try {
    lib = await import('israeli-bank-scrapers');
  } catch {
    throw new Error(
      "israeli-bank-scrapers אינו מותקן. התקן לשלב 2:  npm install israeli-bank-scrapers",
    );
  }
  const { createScraper, CompanyTypes } = lib;

  const scraper = createScraper({
    companyId: CompanyTypes.hapoalim,
    startDate,
    combineInstallments: false,
    showBrowser,
  });

  const result = await scraper.scrape({ userCode, password });
  if (!result.success) {
    throw new Error(`שגיאת scraper: ${result.errorType || ''} ${result.errorMessage || ''}`.trim());
  }

  return (result.accounts || []).map((acc) => ({
    accountNumber: String(acc.accountNumber),
    transactions: (acc.txns || []).map(mapScrapedTransaction),
  }));
}
