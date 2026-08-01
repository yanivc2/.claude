import { fileURLToPath } from 'node:url';
import path from 'node:path';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Session signing secret. MUST be set (SESSION_SECRET) in any deployment so sessions survive
// restarts and can't be forged. Falls back to a random per-process secret for local dev — that
// simply logs everyone out on restart, which is safe.
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// R4 duplicate-warning window: same supplier + same total within this many days.
const DUP_WINDOW_DAYS = Number(process.env.DUP_WINDOW_DAYS ?? 30);

// R3 allocation-number threshold: tax invoice with amount_before_vat over this
// (in agorot) and no allocation number is soft-blocked. 5,000 ILS from 1.6.2026 (§10.2).
const ALLOCATION_THRESHOLD_AGOROT = Number(
  process.env.ALLOCATION_THRESHOLD_AGOROT ?? 5000 * 100,
);

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH
    ? path.resolve(projectRoot, process.env.DB_PATH)
    : path.join(projectRoot, 'data', 'ap-control.sqlite'),
  uploadsDir: process.env.UPLOADS_DIR
    ? path.resolve(projectRoot, process.env.UPLOADS_DIR)
    : path.join(projectRoot, 'uploads'),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024),
  projectRoot,
  // Israeli VAT rate (18% since 1.1.2025). Used for auto-calc on invoice entry.
  vatRate: Number(process.env.VAT_RATE ?? 0.18),
  rules: {
    dupWindowDays: DUP_WINDOW_DAYS,
    allocationThresholdAgorot: ALLOCATION_THRESHOLD_AGOROT,
    // R7 reconciliation: a bank debit matches an open check within this many days
    // of the payment_date. Checks can take weeks to clear, so the default is generous.
    reconcileWindowDays: Number(process.env.RECONCILE_WINDOW_DAYS ?? 60),
  },
  // Stage 2 scraper credentials (Bank Hapoalim). Never hard-code — read from env
  // only, and keep them out of git (§12). Absent by default; the scraper CLI errors
  // clearly if they are missing.
  bank: {
    hapoalim: {
      userCode: process.env.BANK_HAPOALIM_USER_CODE || null,
      password: process.env.BANK_HAPOALIM_PASSWORD || null,
    },
  },
  // Stage 3 OCR. Local by design (§12 — financial documents stay on the PC).
  // langPath lets tesseract load traineddata from a local folder when offline.
  ocr: {
    langs: process.env.OCR_LANGS || 'heb+eng',
    langPath: process.env.OCR_LANG_PATH || null,
  },
  // Stage 4 check printing (Standard 501 / MICR). GATED: printing a real, negotiable
  // check requires bank approval and an approved E-13B MICR encoding (🔴 §11.5, §10.3).
  // Until CHECK_PRINTING_APPROVED=true the layout renders as a watermarked DRAFT with a
  // MICR *placeholder* only — never a scanner-valid magnetic line.
  checkPrinting: {
    approved: process.env.CHECK_PRINTING_APPROVED === 'true',
  },
  // Authentication (real login for cloud exposure). Seed passwords come from env on first run;
  // change them afterwards. sessionSecret signs the stateless session cookie.
  auth: {
    sessionSecret: SESSION_SECRET,
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 12),
    hasExplicitSecret: Boolean(process.env.SESSION_SECRET),
    seedOwnerUsername: process.env.OWNER_USERNAME || 'owner',
    seedOwnerPassword: process.env.OWNER_PASSWORD || 'owner1234',
    seedSecretaryUsername: process.env.SECRETARY_USERNAME || 'secretary',
    seedSecretaryPassword: process.env.SECRETARY_PASSWORD || 'secretary1234',
  },
  // Email (password-reset). Uses Resend's HTTP API (no dependency). With no RESEND_API_KEY the
  // mailer is a no-op and the "forgot password" flow tells the user email isn't configured.
  // appUrl builds absolute reset links; falls back to the request's own origin when unset.
  mail: {
    resendApiKey: process.env.RESEND_API_KEY || null,
    from: process.env.MAIL_FROM || 'AP Control <onboarding@resend.dev>',
    appUrl: process.env.APP_URL || null,
    enabled: Boolean(process.env.RESEND_API_KEY),
  },
  // Z-close alerts via a DEDICATED Telegram bot (§ 2d). The bot token is a secret — read
  // from env only, never committed. chatId defaults to the owner's id but can be overridden.
  // With no token the notifier is a silent no-op, so the app runs fine before setup.
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || '5717967564',
    enabled: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  },
};
