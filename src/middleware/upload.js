import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { del, putBuffer } from '../lib/storage.js';

// Attach a scan/photo of a physical invoice / expense note. The file is parsed into memory,
// then handed to the storage layer (local disk or Vercel Blob). Only the returned opaque ref
// is persisted (invoices.image_path / z_expenses.image_path) — never a raw disk path.

// Deliberately NOT including HEIC/HEIF, even though that is what an iPhone stores by default:
// the extraction API accepts only JPEG/PNG/GIF/WebP, and no desktop browser renders HEIC in the
// review screen either — so storing one would fail twice, later and less clearly. The capture
// screen re-encodes every photo to JPEG before uploading, and Safari transcodes HEIC on a gallery
// pick, so this only bites an unusual path; the message below tells the employee what to do.
const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
]);

const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

function fileFilter(req, file, cb) {
  if (ALLOWED.has(file.mimetype)) return cb(null, true);
  if (HEIC_TYPES.has(file.mimetype)) {
    return cb(
      new Error('קובץ HEIC של אייפון אינו נתמך — צלמו דרך כפתור "פתח סורק" באפליקציה, או שנו בהגדרות המצלמה של האייפון "פורמטים" ל-"הכי תואם"'),
    );
  }
  cb(new Error('סוג קובץ לא נתמך — רק תמונות (JPG/PNG/WEBP/GIF) או PDF'));
}

const uploadInvoiceImage = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
}).single('image');

/**
 * Wrap multer: parse the upload into memory, persist it via the storage layer, and expose the
 * stored ref as req.file.filename (so routes keep persisting req.file.filename). Upload/storage
 * errors surface as req.uploadError (a friendly message) rather than a 500.
 */
export function handleInvoiceImage(req, res, next) {
  uploadInvoiceImage(req, res, async (err) => {
    if (err) {
      req.uploadError = err.message;
      return next();
    }
    if (!req.file) return next();
    try {
      const ext = ALLOWED.get(req.file.mimetype) || path.extname(req.file.originalname) || '';
      req.file.filename = await putBuffer(req.file.buffer, ext, req.file.mimetype);
      next();
    } catch (e) {
      req.uploadError = `שמירת הקובץ נכשלה: ${e.message}`;
      next();
    }
  });
}

// Stage 5 — צילום חשבוניות: several photos (or one multi-page PDF) that together make up ONE
// invoice. Same filter and per-file size limit as the single-image upload; the page order is the
// order the client sent, so the refs array must preserve it.

const uploadScanImages = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: config.maxUploadBytes, files: config.ai.maxScanImages },
}).array('images', config.ai.maxScanImages);

/**
 * Wrap multer for the multi-page scan upload: parse the files into memory, persist each one via
 * the storage layer IN PAGE ORDER, and expose the stored refs as req.uploadedRefs (an array).
 * If any file fails to store, the ones already stored are deleted (best-effort) so no orphan
 * blobs are left behind, and req.uploadError carries a friendly Hebrew message — never a 500.
 */
export function handleScanImages(req, res, next) {
  uploadScanImages(req, res, async (err) => {
    if (err) {
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE'
          ? `קובץ גדול מדי — עד ${Math.round(config.maxUploadBytes / (1024 * 1024))} מ"ב לתמונה`
          : err.code === 'LIMIT_FILE_COUNT'
            ? `יותר מדי קבצים — עד ${config.ai.maxScanImages} עמודים לחשבונית`
            : err.message;
      return next();
    }
    const files = req.files || [];
    if (files.length === 0) return next();

    const refs = [];
    try {
      for (const file of files) {
        const ext = ALLOWED.get(file.mimetype) || path.extname(file.originalname) || '';
        refs.push(await putBuffer(file.buffer, ext, file.mimetype));
      }
      req.uploadedRefs = refs;
      next();
    } catch (e) {
      for (const ref of refs) await del(ref); // best-effort cleanup — del never throws
      req.uploadError = `שמירת הצילומים נכשלה: ${e.message}`;
      next();
    }
  });
}
