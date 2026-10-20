import { Router, json } from 'express';
import multer from 'multer';
import { getExecutor } from '../db/adapter.js';
import { config } from '../config.js';
import { parseRevenueReportAny } from '../lib/revenueReportFile.js';
import { importRevenueRows, importRevenuePeriod, revenueChecks } from '../services/revenueReports.js';
import { formatIls } from '../lib/money.js';
import { notify } from '../lib/notify.js';
import { syncAllLinkedAccounts, importScrapedBatch } from '../services/bankSync.js';
import { financyConfigured } from '../lib/financy.js';
import { timingSafeEqual } from 'node:crypto';
import { claimNext, reportState, takeOtp, completeWithAccounts, agentPing } from '../services/bankSyncJobs.js';
import { webhookSecret } from '../lib/telegramBot.js';
import { revenueIngestSecret, reportDateFrom, pickReportFile, resolveStoreByBranch, branchFromSubject, storeTitleConflict } from '../lib/revenueIngest.js';
import { decodeFileName } from '../lib/decodeText.js';
import { handleTelegramUpdate } from '../services/telegramApprovals.js';

// Machine ingestion for the nightly "דוח פדיון" email. A small Apps Script in the owner's Gmail
// (lib/revenueIngestScript.js — the owner copies it, ready-made, from /reconciliation/revenue-intake)
// finds the POS mail every hour and POSTs its "פדיון" file (XLS, or the PDF of it) here as multipart, with the mail's
// subject and send time. This router is mounted BEFORE the session gate — there is no logged-in
// user — so it is protected by a shared secret (header x-ingest-secret):
//
//   POST /ingest/revenue-report?subject=<POS subject>&sent=<ISO>&file_name=<name>   (or ?store=<id>&date=…)
//
// Store and day are resolved in lib/revenueIngest.js; an unmatched branch is refused and the owner
// is told, never guessed. With no secret available (no env and no explicit SESSION_SECRET) → 503.
const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 10 } }).any();

/**
 * The alert for an imported report: the day's figures, and the two things the owner checks a day
 * by — the acquirers' total against the drawer's credit, and debts paid (not part of the sales).
 */
function revenueNotice(storeName, inserted, updated, last, detailsSaved) {
  const dmy = last.date.split('-').reverse().join('/');
  const lines = [`📈 <b>דוח פדיון נקלט</b>`, `${storeName}: ${inserted} ימים חדשים, ${updated} עודכנו.`];
  let day = `${dmy}: מכירות ${formatIls(last.gross)} · אשראי ${formatIls(last.credit)}`;
  if ('cash' in last) day += ` · מזומן ${formatIls(last.cash)}`;
  if (last.txnCount) day += ` · ${last.txnCount} עסקאות`;
  if (last.cancelAmount) day += ` · ביטולים ${formatIls(last.cancelAmount)}${last.cancelCount ? ` (${last.cancelCount})` : ''}`;
  lines.push(day);
  if ('cash' in last) {
    const c = revenueChecks({ credit_total: last.credit, debt_credit: last.debtCredit, debt_payments: last.debtPayments, cards: JSON.stringify(last.cards || []) });
    if (c.creditGap) lines.push(`⚠️ אשראי לפי חברה ${formatIls(c.cardsTotal)} ≠ אשראי במגירה ${formatIls(last.credit + (last.debtCredit || 0))}`);
    if (c.debt) lines.push(`ℹ️ שולמו חובות ${formatIls(c.debt)} — לא נכללו במכירות`);
  }
  if (!detailsSaved) lines.push('⚠️ פירוט הדוח (מזומן, חברות אשראי, ביטולים, עסקאות) לא נשמר — צריך ללחוץ בהגדרות "עדכן מסד נתונים".');
  return lines.join('\n');
}

router.post('/revenue-report', (req, res) => {
  upload(req, res, async (uploadErr) => {
    try {
      // REVENUE_INGEST_SECRET, or one derived from SESSION_SECRET (lib/revenueIngest.js) — the
      // owner gets it inside the ready-made Gmail script and never has to touch Vercel.
      const secret = revenueIngestSecret();
      if (!secret) return res.status(503).json({ ok: false, error: 'ingest disabled (no secret)' });
      const given = Buffer.from(String(req.get('x-ingest-secret') || req.query.secret || (req.body && req.body.secret) || ''));
      const want = Buffer.from(secret);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return res.status(401).json({ ok: false, error: 'bad secret' });
      if (uploadErr) return res.status(400).json({ ok: false, error: 'upload failed' });

      const x = getExecutor();
      // Hebrew attachment names arrive as latin1 bytes through multipart — decode before matching "פדיון".
      const files = (req.files || []).map((f) => ({ ...f, originalname: decodeFileName(f.originalname) || f.originalname }));
      const file = pickReportFile(files);
      if (!file) return res.status(400).json({ ok: false, error: 'no XLS/CSV/PDF attachment' });

      // Store: an explicit id, or the POS branch named in the subject ("סניף: 3 מידנייט").
      const branch = branchFromSubject(req.query.subject || (req.body && req.body.subject));
      const branchName = String(req.query.branch_name || branch.name || '').trim();
      let store;
      const storeId = Number(req.query.store || (req.body && req.body.store));
      if (storeId) {
        store = await x.one('SELECT id, name FROM stores WHERE id = ?', [storeId]);
        if (!store) return res.status(404).json({ ok: false, error: 'store not found' });
      } else {
        store = resolveStoreByBranch(await x.many('SELECT id, name FROM stores', []), branchName);
        if (!store) {
          await notify(
            `⚠️ <b>דוח פדיון לא נקלט</b>\nהדוח של סניף ${branch.no || '?'} "${branchName || 'ללא שם'}" בקופה לא תואם לשם של אף חנות במערכת. שם החנות צריך להכיל את שם הסניף בקופה (או להפך).`,
            { link: '/reconciliation/revenue-intake' },
          );
          return res.status(422).json({ ok: false, error: 'branch does not match a single store', branch: branchName });
        }
      }

      // The XLS carries no date of its own — see reportDateFrom for the order. A PDF prints its
      // day ("מתאריך … עד …"), and the file's own word beats a stamp or a send time.
      const { date: guessedDate, from: guessedFrom } = reportDateFrom({
        date: req.query.date, fileName: req.query.file_name || file.originalname, sent: req.query.sent,
      });
      const parsed = await parseRevenueReportAny(file.buffer, { reportDate: guessedDate });
      const { rows, warnings, fileDate } = parsed;
      // The PDF names its store; a file of another branch is refused, never filed (lib/revenueIngest.js).
      const other = storeTitleConflict(await x.many('SELECT id, name FROM stores', []), parsed.storeTitle, store.id);
      if (other) {
        await notify(`⚠️ <b>דוח פדיון לא נקלט</b>\nהמייל של ${store.name} נשא דוח של "${parsed.storeTitle}" (${other.name}).`, { link: '/reconciliation/revenue-intake' });
        return res.status(422).json({ ok: false, error: 'report belongs to another store', title: parsed.storeTitle });
      }
      if (parsed.kind === 'period') {
        const p = parsed.period;
        const { replaced } = await importRevenuePeriod(store.id, p, 'email', null);
        const dm = (d) => d.split('-').reverse().join('/');
        await notify(`📈 <b>דוח פדיון תקופתי נקלט</b>\n${store.name}: ${dm(p.from)}–${dm(p.to)} · מכירות ${formatIls(p.gross)} · אשראי ${formatIls(p.credit)}`, { kind: 'revenue', link: '/reports/profitability' });
        return res.json({ ok: true, store: store.name, period: { from: p.from, to: p.to }, replaced: replaced.length });
      }
      const reportDate = fileDate || guessedDate;
      const dateFrom = fileDate ? 'content' : guessedFrom;
      if (!rows.length) {
        await notify(`⚠️ <b>דוח פדיון לא נקלט</b>\n${store.name}: לא זוהו שורות בקובץ שהגיע במייל. ${warnings.join(' ')}`, { link: '/reports/profitability' });
        return res.status(422).json({ ok: false, error: 'no rows parsed', warnings });
      }
      const { inserted, updated, detailsSaved } = await importRevenueRows(store.id, rows, 'email', null);
      const last = rows[rows.length - 1];
      await notify(revenueNotice(store.name, inserted, updated, last, detailsSaved), { kind: 'revenue', link: '/reports/profitability' });
      return res.json({ ok: true, store: store.name, date: reportDate, dateFrom, inserted, updated, days: rows.length, detailsSaved });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
});

// Nightly Open-Banking sync — the scheduled twin of the "משוך תנועות מהבנק" button. Mounted on
// this pre-session router because a cron ping has no logged-in user; authenticated by CRON_SECRET,
// which Vercel Cron sends automatically as `Authorization: Bearer $CRON_SECRET` (a ?key= is
// accepted too, for a curl or a non-Vercel scheduler):
//
//   GET /ingest/bank-sync            (Authorization: Bearer <CRON_SECRET>)
//   GET /ingest/bank-sync?key=<CRON_SECRET>
//
// Without CRON_SECRET set the endpoint is disabled (503) rather than open. Safe to run as often as
// you like: the window overlaps on purpose and external_id dedupes, so a repeat run inserts nothing.
router.all('/bank-sync', async (req, res) => {
  try {
    if (!config.cronSecret) return res.status(503).json({ ok: false, error: 'sync disabled (no CRON_SECRET)' });
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const given = String(req.query.key || req.get('x-cron-secret') || bearer || '');
    if (given !== config.cronSecret) return res.status(401).json({ ok: false, error: 'bad secret' });
    if (!financyConfigured()) {
      return res.status(503).json({ ok: false, error: 'financy not configured (no FINANCY_API_KEY)' });
    }

    // actor = null: a scheduled run has no user. The audit log records it as a system action.
    const r = await syncAllLinkedAccounts({}, null);
    // A partial failure is reported as 207 so a monitoring cron can see it without the run being
    // treated as a total loss — the accounts that did sync are already committed.
    const status = r.errors.length ? (r.results.length ? 207 : 502) : 200;
    return res.status(status).json({ ok: !r.errors.length, ...r });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Nightly voided-check sweep — the clock the "צ׳קים מבוטלים" page runs on.
//
// Voiding a check in the software does not void it at the bank: it stays presentable for six months
// (services/voidedChecks.js). Two of the four void reasons therefore have a deadline rather than a
// state, and neither can be noticed by anything a user does:
//   • "לא נאסף" becomes safe on a DATE — nothing happens in the app that day;
//   • "נפרע במזומן עבור שכר" left unmatched, and a missing link, only get worse with time.
// The same sweep runs after every bank reconcile, but a group that has not imported a statement in
// weeks would hear nothing — so it also runs nightly. Idempotent through payments.void_alerted, so
// a quiet night sends nothing at all.
//
// It also runs the transfer watch, for the same reason: an undocumented transfer is only visible
// once the bank reports it, and nothing a user does would look.
//
//   GET /ingest/voided-checks        (Authorization: Bearer <CRON_SECRET>)
//   GET /ingest/voided-checks?key=<CRON_SECRET>
router.all('/voided-checks', async (req, res) => {
  try {
    if (!config.cronSecret) return res.status(503).json({ ok: false, error: 'sweep disabled (no CRON_SECRET)' });
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const given = String(req.query.key || req.get('x-cron-secret') || bearer || '');
    if (given !== config.cronSecret) return res.status(401).json({ ok: false, error: 'bad secret' });

    const { alertOnVoidedChecks, alertOnExpiredNotCollected } = await import('../services/voidedChecks.js');
    const { alertOnUntrackedTransfers, alertOnTransferProblems } = await import('../services/transfers.js');
    const problems = await alertOnVoidedChecks();
    const expired = await alertOnExpiredNotCollected();
    const untracked = await alertOnUntrackedTransfers();
    const transfers = await alertOnTransferProblems();
    return res.json({ ok: true, problems, expired, untracked, transfers });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Daily bank-sync reminder (owner, 20/10: 12:00 Israel time, Sun–Thu, only when nobody synced today) —
// services/bankSyncJobs.js#bankSyncReminder. Vercel Cron calls it twice (09:00 and 10:00 UTC); it sends only on
// the run where Israel's clock reads 12, once a day. Same CRON_SECRET guard as the routes above.
//
//   GET /ingest/bank-sync-reminder   (Authorization: Bearer <CRON_SECRET>)
router.all('/bank-sync-reminder', async (req, res) => {
  try {
    if (!config.cronSecret) return res.status(503).json({ ok: false, error: 'reminder disabled (no CRON_SECRET)' });
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const given = String(req.query.key || req.get('x-cron-secret') || bearer || '');
    if (given !== config.cronSecret) return res.status(401).json({ ok: false, error: 'bad secret' });
    const { bankSyncReminder } = await import('../services/bankSyncJobs.js');
    return res.json({ ok: true, ...(await bankSyncReminder()) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Scraped-transaction intake — the second bank channel, for accounts Open Banking doesn't cover
// (or doesn't cover affordably). An EXTERNAL runner (scripts/scrape-push.mjs, on a GitHub Actions
// cron or any machine with a browser) logs into the bank with israeli-bank-scrapers and POSTs the
// resulting rows here. Vercel cannot run that scrape itself — a serverless function has no browser.
//
//   POST /ingest/bank-txns      (Authorization: Bearer <CRON_SECRET>)
//   { "accounts": [ { "accountNumber": "412345", "transactions": [ {txnDate, amount, ...} ] } ] }
//
// SECURITY: the bank credentials live ONLY on the runner (GitHub Secrets). They are never sent
// here, never stored in the database, and never reach Vercel — this endpoint receives finished
// rows, exactly like a CSV upload does. Without CRON_SECRET set it is disabled (503).
router.post('/bank-txns', json({ limit: '4mb' }), async (req, res) => {
  try {
    if (!config.cronSecret) return res.status(503).json({ ok: false, error: 'intake disabled (no CRON_SECRET)' });
    const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const given = String(req.query.key || req.get('x-cron-secret') || bearer || '');
    if (given !== config.cronSecret) return res.status(401).json({ ok: false, error: 'bad secret' });

    const r = await importScrapedBatch(req.body, null);
    // Unmapped account numbers are reported, not fatal: the accounts that DID map are committed.
    return res.status(r.unmapped.length ? 207 : 200).json({ ok: true, ...r });
  } catch (err) {
    return res.status(err.rule === 'SCRAPER' ? 400 : 500).json({ ok: false, error: err.message });
  }
});

// 🏦 סוכן סנכרון הבנק (מחשב המשרד). הדפדפן רץ שם כי ל-Vercel אין דפדפן; המסד הוא הגשר.
// ראה services/bankSyncJobs.js למכונת המצבים המלאה.
//
//   POST /ingest/bank-agent/claim          → { job: {id, loginKey} | null }   (גם פעימת חיים)
//   POST /ingest/bank-agent/:id/state      { status: running|awaiting_otp|failed, message }
//   POST /ingest/bank-agent/:id/otp        → { otp } | { otp: null } | { cancelled }
//   POST /ingest/bank-agent/:id/result     { accounts: [...] }  (אותו מבנה של /bank-txns)
//
// 🔴 הסוד מתקבל **רק בכותרת** (`Authorization: Bearer …` או `X-Agent-Secret`), לא ב-?key=:
// כתובות URL נרשמות ביומני הגישה, ונקודות הקצה האלה מעבירות קודי SMS של הבנק. ההשוואה
// בזמן קבוע, כדי שזמן התגובה לא ידליף כמה תווים מהסוד נכונים.
function agentAuth(req, res) {
  const secret = config.bankAgentSecret;
  if (!secret) {
    res.status(503).json({ ok: false, error: 'bank agent disabled (no BANK_AGENT_SECRET / CRON_SECRET)' });
    return false;
  }
  const bearer = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const given = Buffer.from(String(req.get('x-agent-secret') || bearer || ''));
  const want = Buffer.from(String(secret));
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    res.status(401).json({ ok: false, error: 'bad secret' });
    return false;
  }
  return true;
}

const agentName = (req) => String(req.get('x-agent-name') || req.body?.agent || 'agent').slice(0, 80);

function agentError(res, err) {
  const known = err && (err.rule || err.name === 'NotFoundError');
  return res.status(known ? 400 : 500).json({ ok: false, error: err?.message || 'error' });
}

router.post('/bank-agent/ping', json(), async (req, res) => {
  if (!agentAuth(req, res)) return;
  try {
    return res.json(await agentPing(agentName(req), undefined, { hours: req.body?.hours, offEvery: req.body?.offEvery }));
  } catch (err) {
    return agentError(res, err);
  }
});

router.post('/bank-agent/claim', json(), async (req, res) => {
  if (!agentAuth(req, res)) return;
  try {
    return res.json({ ok: true, job: await claimNext(agentName(req), undefined, { hours: req.body?.hours, mode: req.body?.mode, offEvery: req.body?.offEvery }) });
  } catch (err) {
    return agentError(res, err);
  }
});

router.post('/bank-agent/:id/state', json(), async (req, res) => {
  if (!agentAuth(req, res)) return;
  try {
    const r = await reportState(req.params.id, { status: req.body?.status, message: req.body?.message }, agentName(req));
    return res.json({ ok: true, ...r });
  } catch (err) {
    return agentError(res, err);
  }
});

router.post('/bank-agent/:id/otp', json(), async (req, res) => {
  if (!agentAuth(req, res)) return;
  try {
    // no-store: קוד חד-פעמי אסור שיישב במטמון של אף שכבה בדרך.
    res.set('Cache-Control', 'no-store');
    return res.json({ ok: true, ...(await takeOtp(req.params.id, agentName(req))) });
  } catch (err) {
    return agentError(res, err);
  }
});

router.post('/bank-agent/:id/result', json({ limit: '4mb' }), async (req, res) => {
  if (!agentAuth(req, res)) return;
  try {
    const r = await completeWithAccounts(req.params.id, req.body, agentName(req));
    return res.json({ ok: true, ...r });
  } catch (err) {
    return agentError(res, err);
  }
});

// Telegram webhook — the owner tapped "✓ אשר" / "✕ דחה" under an approval request
// (lib/telegramBot.js, services/telegramApprovals.js). Pre-session like the rest of this router:
// Telegram is the caller, not a logged-in browser. Gate 1 is the secret_token Telegram echoes in
// X-Telegram-Bot-Api-Secret-Token (set by setWebhook, derived from the bot token); gate 2 — that the
// tap is the owner's own — is checked by the service. A bad tap still answers 200, or Telegram
// would keep re-sending it.
router.post('/telegram', json({ limit: '256kb' }), async (req, res) => {
  const secret = webhookSecret();
  if (!secret) return res.status(503).json({ ok: false, error: 'telegram not configured' });
  const given = Buffer.from(String(req.get('x-telegram-bot-api-secret-token') || ''));
  const want = Buffer.from(secret);
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return res.status(401).json({ ok: false, error: 'bad secret' });
  }
  try {
    const r = await handleTelegramUpdate(req.body || {});
    return res.json({ ok: true, ...r });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[telegram webhook]', err);
    return res.json({ ok: false });
  }
});

export default router;
