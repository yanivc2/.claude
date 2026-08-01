import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

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
};
