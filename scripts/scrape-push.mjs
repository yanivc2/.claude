#!/usr/bin/env node
// Bank scrape runner — the second bank channel, run OUTSIDE the app.
//
// Why outside: israeli-bank-scrapers drives a real Chromium against the bank's website. A Vercel
// serverless function has no browser and a 300s ceiling, so this runs on a machine that does have
// one — a GitHub Actions cron (see .github/workflows/bank-scrape.yml), a small VPS, or your own PC.
//
// It logs in, scrapes, and POSTs the finished rows to /ingest/bank-txns. THE APP NEVER SEES THE
// BANK CREDENTIALS: they exist only in this runner's environment (GitHub Secrets), never in the
// database, never on Vercel.
//
//   node scripts/scrape-push.mjs                 # default window (BANK_SCRAPE_DAYS, default 90)
//   node scripts/scrape-push.mjs 2026-01-01      # from an explicit start date
//   node scripts/scrape-push.mjs --dry-run       # scrape and print, POST nothing
//
// Environment:
//   BANK_SCRAPERS   JSON array — which institutions to scrape and with what credentials, e.g.
//                   [{"companyId":"hapoalim","credentials":{"userCode":"…","password":"…"}},
//                    {"companyId":"isracard","credentials":{"id":"…","card6Digits":"…","password":"…"}}]
//                   The credential keys are whatever that scraper expects; they are passed through.
//   AP_INGEST_URL   e.g. https://ap-control.vercel.app
//   CRON_SECRET     same value the app has — authenticates the POST
//   BANK_SCRAPE_DAYS  how far back to scrape (default 90). The window overlaps on purpose;
//                     external_id dedupes, so re-scraping costs nothing but time.

import { scrapeInstitution } from '../src/scraper/scrape.js';

const log = (...a) => console.log(...a); // eslint-disable-line no-console
const err = (...a) => console.error(...a); // eslint-disable-line no-console

function parseTargets() {
  const raw = process.env.BANK_SCRAPERS;
  if (!raw) throw new Error('חסר BANK_SCRAPERS (JSON של מוסדות + פרטי התחברות)');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`BANK_SCRAPERS אינו JSON תקין: ${e.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.length) throw new Error('BANK_SCRAPERS ריק');
  for (const t of list) {
    if (!t?.companyId) throw new Error('כל פריט ב-BANK_SCRAPERS חייב companyId');
    if (!t?.credentials) throw new Error(`חסרים credentials עבור ${t.companyId}`);
  }
  return list;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const startArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const days = Number(process.env.BANK_SCRAPE_DAYS ?? 90);
  const startDate = startArg ? new Date(`${startArg}T00:00:00Z`) : new Date(Date.now() - days * 86400000);

  const targets = parseTargets();
  log(`Scraping ${targets.length} institution(s) from ${startDate.toISOString().slice(0, 10)} …`);

  // Collect across institutions, keyed by account number — the app maps those to its bank accounts.
  const accounts = [];
  const failures = [];
  for (const t of targets) {
    try {
      const got = await scrapeInstitution({ companyId: t.companyId, credentials: t.credentials, startDate });
      for (const acc of got) {
        log(`  ${t.companyId} · account ${acc.accountNumber}: ${acc.transactions.length} rows`);
        accounts.push(acc);
      }
    } catch (e) {
      // One institution failing must not cost the others — report and continue.
      failures.push(`${t.companyId}: ${e.message}`);
      err(`  ! ${t.companyId} failed: ${e.message}`);
    }
  }

  if (!accounts.length) {
    err(failures.length ? `No data scraped. Failures:\n  ${failures.join('\n  ')}` : 'No data scraped.');
    process.exit(1);
  }

  if (dryRun) {
    log(JSON.stringify({ accounts }, null, 2));
    log(`\n[dry-run] would POST ${accounts.reduce((n, a) => n + a.transactions.length, 0)} rows`);
    return;
  }

  const base = (process.env.AP_INGEST_URL || '').replace(/\/+$/, '');
  const secret = process.env.CRON_SECRET;
  if (!base) throw new Error('חסר AP_INGEST_URL');
  if (!secret) throw new Error('חסר CRON_SECRET');

  const res = await fetch(`${base}/ingest/bank-txns`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ accounts }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`הקליטה נכשלה (${res.status}): ${body.error || ''}`);

  log(
    `Done: ${body.inserted} imported, ${body.skipped} already existed, ${body.matched} auto-matched` +
      (body.unmapped?.length ? `, unmapped accounts: ${body.unmapped.join(', ')}` : ''),
  );
  // A failed institution is a real problem even when the others succeeded — surface it in CI.
  if (failures.length) {
    err(`\nSome institutions failed:\n  ${failures.join('\n  ')}`);
    process.exit(2);
  }
}

main().catch((e) => {
  err(e.message || e);
  process.exit(1);
});
