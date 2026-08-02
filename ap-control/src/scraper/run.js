import { initDb, getExecutor } from '../db/index.js';
import { seed } from '../db/seed.js';
import { config } from '../config.js';
import { scrapeHapoalim } from './hapoalim.js';
import { importTransactions } from '../services/bankTransactions.js';

// CLI: scrape Bank Hapoalim and import completed transactions into bank_transactions.
//   node src/scraper/run.js            (last ~365 days)
//   node src/scraper/run.js 2026-01-01 (from a given start date)
//
// Requires israeli-bank-scrapers installed and BANK_HAPOALIM_* credentials in the env (§12).
// This is deliberately a CLI, not a web request — a Puppeteer scrape is slow and interactive.

async function main() {
  await initDb();
  await seed();
  const x = getExecutor();

  const startArg = process.argv[2];
  const startDate = startArg
    ? new Date(startArg)
    : new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);

  const { userCode, password } = config.bank.hapoalim;
  // eslint-disable-next-line no-console
  console.log(`Scraping Hapoalim from ${startDate.toISOString().slice(0, 10)} ...`);

  const accounts = await scrapeHapoalim({ userCode, password, startDate });

  const rows = await x.many('SELECT id, account_number FROM bank_accounts', []);
  const byNumber = new Map(rows.map((r) => [String(r.account_number), r.id]));

  let totalIn = 0;
  let totalSkip = 0;
  let unmapped = 0;
  for (const acc of accounts) {
    const bankAccountId = byNumber.get(acc.accountNumber);
    if (!bankAccountId) {
      unmapped += 1;
      // eslint-disable-next-line no-console
      console.warn(`  ! account ${acc.accountNumber} is not registered in bank_accounts — skipped`);
      continue;
    }
    const txnRows = acc.transactions.filter((t) => !t.status || t.status === 'completed');
    const { inserted, skipped } = await importTransactions(bankAccountId, txnRows, 'scraper', null, x);
    totalIn += inserted;
    totalSkip += skipped;
    // eslint-disable-next-line no-console
    console.log(`  account ${acc.accountNumber}: +${inserted} new, ${skipped} existing`);
  }

  // eslint-disable-next-line no-console
  console.log(`Done: ${totalIn} imported, ${totalSkip} skipped, ${unmapped} unmapped accounts.`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message || err);
  process.exit(1);
});
