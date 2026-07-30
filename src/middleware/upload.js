import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { config } from '../config.js';

// Stage 1b: attach a scan/photo of the physical invoice (no OCR — that is stage 3).
// Files are stored on disk under uploads/ (gitignored, backed up out-of-band per §12)
// with a non-guessable UUID filename; only the filename is persisted in invoices.image_path.

fs.mkdirSync(config.uploadsDir, { recursive: true });

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
]);

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, config.uploadsDir);
  },
  filename(req, file, cb) {
    const ext = ALLOWED.get(file.mimetype) || path.extname(file.originalname) || '';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (ALLOWED.has(file.mimetype)) return cb(null, true);
  cb(new Error('סוג קובץ לא נתמך — רק תמונות (JPG/PNG/WEBP/GIF) או PDF'));
}

export const uploadInvoiceImage = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxUploadBytes, files: 1 },
}).single('image');

/**
 * Wrap the multer middleware so upload errors (bad type, too large) render as a
 * friendly message instead of a 500. Attaches nothing else — the route reads req.file.
 */
export function handleInvoiceImage(req, res, next) {
  uploadInvoiceImage(req, res, (err) => {
    if (err) {
      req.uploadError = err.message;
    }
    next();
  });
}
