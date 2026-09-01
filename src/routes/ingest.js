import { Router } from 'express';
import multer from 'multer';
import { getExecutor } from '../db/adapter.js';
import { config } from '../config.js';
import { parseRevenueReport } from '../lib/revenueReportFile.js';
import { importRevenueRows } from '../services/revenueReports.js';
import { notify } from '../lib/notify.js';
import { israelToday } from '../lib/loginHours.js';

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

export default router;
