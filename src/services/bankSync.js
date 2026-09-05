// Open-Banking sync: pull a bank account's movements from Financy straight into
// bank_transactions, then run the existing R7 matching engine over them.
//
// This is the SAME pipeline as the CSV import — `importTransactions` + `autoReconcile` — with the
// file swapped for an API call. Nothing about matching, scoping or the reconciliation UI changes;
// the only new state is `bank_accounts.financy_account_id` (which provider account to pull) and
// `bank_transactions.external_id` (the provider's row id, so a re-pull is idempotent).

import { getExecutor } from '../db/adapter.js';
import { NotFoundError, RuleError } from '../lib/errors.js';
import { israelToday } from '../lib/loginHours.js';
import { notify } from '../lib/notify.js';
import { config } from '../config.js';
import { financyConfigured, fetchFinancyAccounts, fetchFinancyTransactions } from '../lib/financy.js';
import { mapFinancyTransactions, matchFinancyAccount } from '../lib/financyMap.js';
import { importTransactions } from './bankTransactions.js';
import { autoReconcile } from './reconciliation.js';
import { logAction } from './audit.js';

/** 'YYYY-MM-DD' N days before the Israel-local today. */
export function daysAgoInIsrael(days) {
  const t = Date.parse(`${israelToday()}T00:00:00Z`);
  return new Date(t - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Link AP Control's bank accounts to their Financy counterparts by branch + account number, so the
 * owner never copies an opaque provider id by hand. Only unambiguous matches are written; an
 * account already linked is left alone.
 * @returns {{linked:Array, unmatched:Array, alreadyLinked:number}}
 */
export async function linkFinancyAccounts(actor, x = getExecutor()) {
  if (!financyConfigured()) {
    throw new RuleError('FINANCY', 'חיבור Financy לא מוגדר. הוסף FINANCY_API_KEY בהגדרות Vercel.');
  }
  const provider = await fetchFinancyAccounts();
  const accounts = await x.many('SELECT * FROM bank_accounts ORDER BY id', []);

  const linked = [];
  const unmatched = [];
  let alreadyLinked = 0;

  for (const acct of accounts) {
    if (acct.financy_account_id) {
      alreadyLinked += 1;
      continue;
    }
    const hit = matchFinancyAccount(provider, acct);
    if (!hit?.id) {
      unmatched.push({ id: acct.id, displayName: acct.display_name });
      continue;
    }
    await x.run('UPDATE bank_accounts SET financy_account_id = ? WHERE id = ?', [String(hit.id), acct.id]);
    linked.push({ id: acct.id, displayName: acct.display_name, financyAccountId: String(hit.id) });
  }

  await logAction(
    {
      userId: actor?.id ?? null,
      action: 'bank.financy_link',
      entityType: 'bank_account',
      entityId: null,
      details: { linked: linked.length, unmatched: unmatched.length, alreadyLinked },
    },
    x,
  );
  return { linked, unmatched, alreadyLinked };
}

/**
 * Pull one account's movements and reconcile them.
 * The date window deliberately OVERLAPS previous syncs (default 90 days): the bank can post a
 * transaction days after its value date, and re-fetching costs nothing because `external_id`
 * dedupes. Returns the same counters the CSV import shows, plus the matching results.
 * @returns {{inserted:number, skipped:number, fetched:number, matched:number, voidedSeen:number, from:string, to:string}}
 */
export async function syncBankAccount(bankAccountId, opts = {}, actor, x = getExecutor()) {
  const account = await x.one('SELECT * FROM bank_accounts WHERE id = ?', [bankAccountId]);
  if (!account) throw new NotFoundError(`חשבון בנק ${bankAccountId} לא נמצא`);
  if (!account.financy_account_id) {
    throw new RuleError(
      'FINANCY',
      `החשבון "${account.display_name}" לא מקושר ל-Financy. הרץ "קשר חשבונות" בהגדרות תחילה.`,
    );
  }

  const days = Number.isFinite(opts.days) && opts.days > 0 ? Math.floor(opts.days) : config.financy.syncDays;
  const dateFrom = opts.from || daysAgoInIsrael(days);
  const dateTo = opts.to || israelToday();

  const raw = await fetchFinancyTransactions({
    accountId: account.financy_account_id,
    dateFrom,
    dateTo,
  });
  const rows = mapFinancyTransactions(raw);

  const { inserted, skipped } = rows.length
    ? await importTransactions(bankAccountId, rows, 'financy', actor, x)
    : { inserted: 0, skipped: 0 };

  // Only worth running the matcher when something new landed.
  let matched = 0;
  let voidedSeen = 0;
  if (inserted > 0) {
    const rec = await autoReconcile(bankAccountId, actor, x);
    matched = rec?.matched ?? 0;
    voidedSeen = rec?.voidedSeen ?? 0;
  }

  await logAction(
    {
      userId: actor?.id ?? null,
      action: 'bank.financy_sync',
      entityType: 'bank_account',
      entityId: bankAccountId,
      details: { fetched: raw.length, inserted, skipped, matched, dateFrom, dateTo },
    },
    x,
  );

  if (inserted > 0) {
    notify(
      `🏦 <b>סנכרון בנק</b>\n${account.display_name}: ${inserted} תנועות חדשות, ${matched} הותאמו אוטומטית לתשלומים.`,
      { kind: 'bank', link: `/reconciliation?account=${bankAccountId}` },
    );
  }

  return { inserted, skipped, fetched: raw.length, matched, voidedSeen, from: dateFrom, to: dateTo };
}

/**
 * Sync every LINKED bank account — what the nightly scheduler calls. One account's failure (a bank
 * that is briefly unreachable, a consent that expired) must not stop the others, so each is caught
 * and reported rather than thrown; the caller decides whether a partial run is an error.
 * @returns {{accounts:number, inserted:number, matched:number, results:Array, errors:Array}}
 */
export async function syncAllLinkedAccounts(opts = {}, actor, x = getExecutor()) {
  const accounts = await x.many(
    'SELECT id, display_name FROM bank_accounts WHERE financy_account_id IS NOT NULL ORDER BY id',
    [],
  );

  const results = [];
  const errors = [];
  for (const acct of accounts) {
    try {
      const r = await syncBankAccount(acct.id, opts, actor, x);
      results.push({ accountId: acct.id, displayName: acct.display_name, ...r });
    } catch (e) {
      errors.push({ accountId: acct.id, displayName: acct.display_name, error: e.message });
    }
  }

  if (errors.length) {
    notify(
      `⚠️ <b>סנכרון בנק נכשל</b>\n${errors.map((e) => `• ${e.displayName}: ${e.error}`).join('\n')}`,
      { kind: 'bank', link: '/reconciliation' },
    );
  }

  return {
    accounts: accounts.length,
    inserted: results.reduce((n, r) => n + r.inserted, 0),
    matched: results.reduce((n, r) => n + r.matched, 0),
    results,
    errors,
  };
}
