import { Router, json } from 'express';
import multer from 'multer';
import { getExecutor } from '../db/adapter.js';
import { config } from '../config.js';
import { parseRevenueReport } from '../lib/revenueReportFile.js';
import { importRevenueRows } from '../services/revenueReports.js';
import { notify } from '../lib/notify.js';
import { israelToday } from '../lib/loginHours.js';
import { syncAllLinkedAccounts, importScrapedBatch } from '../services/bankSync.js';
import { financyConfigured } from '../lib/financy.js';

/** Yesterday in Israel time — the business day the nightly report covers. */
function yesterdayInIsrael() {
  const d = new Date(`${israelToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Machine ingestion for the nightly "דוח פדיון" email. An inbound-email provider (Mailgun routes /
// SendGrid Inbound Parse / CloudMailin) receives the report mail and POSTs it here as multipart with
// the XLS attached. This router is mounted BEFORE the session gate — there is no logged-in user —
// so it is protected by a shared secret and by naming the target store in the URL:
//
//   POST /ingest/revenue-report?store=<storeId>&secret=<REVENUE_INGEST_SECRET>
//
// Without REVENUE_INGEST_SECRET set the endpoint is disabled (503), so it can never be open.
const router = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 10 } }).any();

const isReportFile = (f) => /\.(xlsx?|csv)$/i.test(f.originalname || '') || /excel|spreadsheet|csv/i.test(f.mimetype || '');

router.post('/revenue-report', (req, res) => {
  upload(req, res, async (uploadErr) => {
    try {
      const secret = config.revenueIngestSecret;
      if (!secret) return res.status(503).json({ ok: false, error: 'ingest disabled (no REVENUE_INGEST_SECRET)' });
      const given = req.query.secret || req.get('x-ingest-secret') || (req.body && req.body.secret);
      if (given !== secret) return res.status(401).json({ ok: false, error: 'bad secret' });
      if (uploadErr) return res.status(400).json({ ok: false, error: 'upload failed' });

      const storeId = Number(req.query.store || (req.body && req.body.store));
      if (!storeId) return res.status(400).json({ ok: false, error: 'missing store' });
      const store = await getExecutor().one('SELECT id, name FROM stores WHERE id = ?', [storeId]);
      if (!store) return res.status(404).json({ ok: false, error: 'store not found' });

      const file = (req.files || []).find(isReportFile);
      if (!file) return res.status(400).json({ ok: false, error: 'no XLS/CSV attachment' });

      // The POS summary report carries no date; the nightly mail arrives after 00:30 for the
      // PREVIOUS business day. Accept an explicit ?date=, else default to yesterday (Israel).
      const reportDate = String(req.query.date || '').trim() || yesterdayInIsrael();
      const { rows, warnings } = parseRevenueReport(file.buffer, { reportDate });
      if (!rows.length) {
        notify(`⚠️ <b>דוח פדיון לא נקלט</b>\n${store.name}: לא זוהו שורות בקובץ שהגיע במייל. ${warnings.join(' ')}`, { link: '/reports/profitability' });
        return res.status(422).json({ ok: false, error: 'no rows parsed', warnings });
      }
      const { inserted, updated } = await importRevenueRows(storeId, rows, 'email', null);
      const last = rows[rows.length - 1];
      notify(
        `📈 <b>דוח פדיון נקלט</b>\n${store.name}: ${inserted} ימים חדשים, ${updated} עודכנו.\nאחרון ${last.date}: פדיון ${last.gross / 100} ₪ · אשראי ${last.credit / 100} ₪`,
        { kind: 'revenue', link: '/reports/profitability' },
      );
      return res.json({ ok: true, inserted, updated, days: rows.length });
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

export default router;
