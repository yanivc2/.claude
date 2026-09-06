// Bank Hapoalim adapter — kept as the named entry point the local CLI and older callers use.
// The real work now lives in the generic, multi-institution scraper (./scrape.js) and the pure
// mapper (../lib/scraperMap.js), so banks and credit-card issuers share one code path.

import { scrapeInstitution } from './scrape.js';

export { mapScrapedTransaction, mapScrapedTransactions } from '../lib/scraperMap.js';

/**
 * Scrape Bank Hapoalim and return mapped transactions grouped by account number.
 * @param {{userCode:string, password:string, startDate:Date, showBrowser?:boolean}} opts
 */
export async function scrapeHapoalim({ userCode, password, startDate, showBrowser = false }) {
  if (!userCode || !password) {
    throw new Error('חסרים פרטי התחברות לבנק (BANK_HAPOALIM_USER_CODE / BANK_HAPOALIM_PASSWORD)');
  }
  return scrapeInstitution({
    companyId: 'hapoalim',
    credentials: { userCode, password },
    startDate,
    showBrowser,
  });
}
