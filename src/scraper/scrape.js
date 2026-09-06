// Adapter for israeli-bank-scrapers — banks AND credit-card issuers.
//
// The library is a Puppeteer scraper driving the institution's own website, NOT an official API.
// It is an OPTIONAL dependency, loaded lazily, so the app installs, tests and deploys without it:
// only the scrape runner ever needs it (`npm install israeli-bank-scrapers`), and that runner does
// NOT run on Vercel — a serverless function has no browser. See scripts/scrape-push.mjs.
//
// 🔴 Operational reality, verify per institution before relying on it:
//   • whether the row text/identifier carries the CHECK NUMBER (it drives deterministic matching;
//     the R7 engine still works without it, just with more manual decisions)
//   • whether login works unattended, or the institution demands an OTP on every login
//   • the site changing under the scraper is a "when", not an "if"

import { mapScrapedTransactions } from '../lib/scraperMap.js';

/** Institutions this app is wired for. Keys are israeli-bank-scrapers' own CompanyTypes names. */
export const SCRAPER_COMPANIES = [
  'hapoalim', 'leumi', 'discount', 'mizrahi', 'otsarHahayal', 'beinleumi', 'massad', 'yahav', 'union',
  'isracard', 'amex', 'visaCal', 'max',
];

async function loadLib() {
  try {
    return await import('israeli-bank-scrapers');
  } catch {
    throw new Error(
      'israeli-bank-scrapers אינו מותקן. התקן ברץ הסריקה בלבד:  npm install israeli-bank-scrapers',
    );
  }
}

/**
 * Scrape one institution and return its accounts with rows already in bank_transactions shape.
 * @param {{companyId:string, credentials:object, startDate:Date, showBrowser?:boolean}} opts
 *   `credentials` is whatever that scraper wants (Hapoalim: {userCode,password};
 *   Leumi/Isracard/Cal/Max: {username|id, password, card6Digits...}) — passed through untouched.
 * @returns {Promise<Array<{accountNumber:string, transactions:Array}>>}
 */
export async function scrapeInstitution({ companyId, credentials, startDate, showBrowser = false }) {
  if (!companyId) throw new Error('חסר companyId למשיכה');
  if (!credentials || !Object.keys(credentials).length) {
    throw new Error(`חסרים פרטי התחברות עבור ${companyId}`);
  }

  const { createScraper, CompanyTypes } = await loadLib();
  const type = CompanyTypes[companyId];
  if (!type) throw new Error(`מוסד לא מוכר ל-israeli-bank-scrapers: ${companyId}`);

  const scraper = createScraper({ companyId: type, startDate, combineInstallments: false, showBrowser });
  const result = await scraper.scrape(credentials);
  if (!result.success) {
    throw new Error(`שגיאת scraper (${companyId}): ${result.errorType || ''} ${result.errorMessage || ''}`.trim());
  }

  return (result.accounts || []).map((acc) => {
    const accountNumber = String(acc.accountNumber);
    return {
      accountNumber,
      transactions: mapScrapedTransactions(acc.txns, { companyId, accountNumber }),
    };
  });
}
