import { getExecutor } from '../db/adapter.js';
import { config } from '../config.js';
import { RuleError } from '../lib/errors.js';
import { scrapeHapoalim } from '../scraper/hapoalim.js';
import { importTransactions } from './bankTransactions.js';
import { logAction } from './audit.js';

// One-click bank pull: scrape Bank Hapoalim and import completed transactions into
// bank_transactions — the web-button counterpart of the `npm run scrape` CLI. Puppeteer is heavy
// and local-only (it can't run on a serverless host), so this belongs to the office/local mode.

/** True when the bank credentials are present in the environment (§12 — env only, never the UI). */
export function scrapeConfigured() {
  return Boolean(config.bank.hapoalim.userCode && config.bank.hapoalim.password);
}

/** True on a serverless host, where a headless-browser scrape can't run (import CSV there). */
export function scrapeRunnable() {
  return !process.env.VERCEL;
}

/**
 * Scrape Hapoalim from `startDate` (default: last 60 days) and import each account's completed
 * transactions. Returns a summary. All failure modes (missing credentials, missing library,
 * login/2FA, scraper errors) surface as a RuleError with a Hebrew, actionable message so the
 * route can show it in-page rather than 500.
 */
export async function scrapeAndImport({ startDate = null } = {}, actor, x = getExecutor()) {
  const { userCode, password } = config.bank.hapoalim;
  if (!userCode || !password) {
    throw new RuleError(
      'SCRAPE',
      'פרטי התחברות לבנק אינם מוגדרים. הגדר BANK_HAPOALIM_USER_CODE ו-BANK_HAPOALIM_PASSWORD בסביבה ונסה שוב.',
    );
  }
  const start = startDate ? new Date(`${startDate}T00:00:00`) : new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);

  let accounts;
  try {
    accounts = await scrapeHapoalim({ userCode, password, startDate: start });
  } catch (e) {
    throw new RuleError('SCRAPE', e.message);
  }

  const rows = await x.many('SELECT id, account_number FROM bank_accounts', []);
  const byNumber = new Map(rows.map((r) => [String(r.account_number), r.id]));

  let imported = 0;
  let skipped = 0;
  const unmapped = [];
  for (const acc of accounts) {
    const bankAccountId = byNumber.get(acc.accountNumber);
    if (!bankAccountId) {
      unmapped.push(acc.accountNumber);
      continue;
    }
    const txnRows = acc.transactions.filter((t) => !t.status || t.status === 'completed');
    const r = await importTransactions(bankAccountId, txnRows, 'scraper', actor, x);
    imported += r.inserted;
    skipped += r.skipped;
  }

  await logAction(
    { userId: actor?.id ?? null, action: 'bank.scrape', entityType: 'bank', details: { imported, skipped, unmapped } },
    x,
  );
  return { imported, skipped, unmapped, accounts: accounts.length, from: start.toISOString().slice(0, 10) };
}
