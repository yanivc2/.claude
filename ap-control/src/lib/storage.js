// File storage abstraction for uploaded invoice / expense images.
//
// Backend is chosen by environment:
//   * BLOB_READ_WRITE_TOKEN present -> Vercel Blob (cloud; the serverless filesystem is ephemeral)
//   * otherwise                     -> local disk under config.uploadsDir (the office/local mode)
//
// A stored file is referenced by an opaque string ("ref") kept in the DB (invoices.image_path,
// z_expenses.image_path): a bare filename for local disk, a full blob URL for Vercel Blob.
// getObject/del/localPath branch on whether the ref looks like an http(s) URL, so the same DB
// rows work whichever backend served them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const EXT_TO_TYPE = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.pdf', 'application/pdf'],
]);

export function contentTypeForRef(ref) {
  const ext = path.extname(new URL(ref, 'http://x').pathname || ref).toLowerCase();
  return EXT_TO_TYPE.get(ext) || 'application/octet-stream';
}

function useBlob() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function isRemote(ref) {
  return /^https?:\/\//i.test(ref);
}

/**
 * Store a buffer and return its ref (to persist in the DB).
 * @param {Buffer} buffer
 * @param {string} ext  file extension incl. dot, e.g. '.jpg'
 * @param {string} contentType
 */
export async function putBuffer(buffer, ext, contentType) {
  const key = `${crypto.randomUUID()}${ext || ''}`;
  if (useBlob()) {
    const { put } = await import('@vercel/blob');
    const { url } = await put(`uploads/${key}`, buffer, {
      access: 'public', // Blob has only public URLs; the UUID key is unguessable, served via our routes
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      addRandomSuffix: false, // key is already a UUID — keep a clean extension for content-type
    });
    return url;
  }
  try {
    fs.mkdirSync(config.uploadsDir, { recursive: true });
    fs.writeFileSync(path.join(config.uploadsDir, key), buffer);
    return key;
  } catch (err) {
    // On a serverless host (e.g. Vercel) the filesystem is read-only, so local storage fails.
    // Cloud file storage must be configured — surface a clear, actionable message.
    if (['EROFS', 'ENOENT', 'EACCES'].includes(err.code)) {
      throw new Error(
        'אחסון קבצים בענן אינו מוגדר. כדי לשמור תמונות/קבצים יש להוסיף Vercel Blob ' +
          '(משתנה סביבה BLOB_READ_WRITE_TOKEN) ולפרוס מחדש.',
      );
    }
    throw err;
  }
}

/** Fetch a stored file as { buffer, contentType }. */
export async function getObject(ref) {
  if (isRemote(ref)) {
    const res = await fetch(ref);
    if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') || contentTypeForRef(ref) };
  }
  const buffer = fs.readFileSync(path.join(config.uploadsDir, path.basename(ref)));
  return { buffer, contentType: contentTypeForRef(ref) };
}

/** Delete a stored file. Never throws — orphan cleanup is best-effort. */
export async function del(ref) {
  if (!ref) return;
  try {
    if (isRemote(ref)) {
      const { del: blobDel } = await import('@vercel/blob');
      await blobDel(ref, { token: process.env.BLOB_READ_WRITE_TOKEN });
    } else {
      fs.rmSync(path.join(config.uploadsDir, path.basename(ref)), { force: true });
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Return a local filesystem path for a ref (for tools like tesseract that need a real file).
 * Local refs resolve directly; remote refs are downloaded to a temp file the caller may delete.
 */
export async function localPath(ref) {
  if (!isRemote(ref)) return path.join(config.uploadsDir, path.basename(ref));
  const { buffer } = await getObject(ref);
  const tmp = path.join(os.tmpdir(), `ap-${crypto.randomUUID()}${path.extname(new URL(ref).pathname)}`);
  fs.writeFileSync(tmp, buffer);
  return tmp;
}
