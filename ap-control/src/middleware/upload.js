import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { putBuffer } from '../lib/storage.js';

// Attach a scan/photo of a physical invoice / expense note. The file is parsed into memory,
// then handed to the storage layer (local disk or Vercel Blob). Only the returned opaque ref
// is persisted (invoices.image_path / z_expenses.image_path) — never a raw disk path.

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['application/pdf', '.pdf'],
]);

function fileFilter(req, file, cb) {
  if (ALLOWED.has(file.mimetype)) return cb(null, true);
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
