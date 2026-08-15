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

// Blobs are stored PRIVATE by default: the app serves every file through its own authenticated
// routes (getObject reads server-side with the token), so files are never publicly reachable.
// Override with BLOB_ACCESS=public only if the store requires it.
function blobAccess() {
  return process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';
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
      access: blobAccess(), // private by default; served via our authenticated routes
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

/**
 * Fetch a stored file as { buffer, contentType }.
 *
 * Every failure here is logged with its cause. It used to swallow the SDK error with a bare
 * `catch {}` and fall through to a public fetch, so "the images don't open" arrived with nothing
 * in the logs at all — the same shape as the extraction bug that took hours to find for exactly
 * the same reason. A read that fails must say why.
 */
export async function getObject(ref) {
  if (isRemote(ref)) {
    let sdkError = null;
    // Private blob: read server-side with the token via the SDK. Falls back to a plain fetch
    // for public/legacy blobs (or if the SDK read fails).
    if (process.env.BLOB_READ_WRITE_TOKEN) {
      try {
        const { get } = await import('@vercel/blob');
        const r = await get(ref, { access: blobAccess(), token: process.env.BLOB_READ_WRITE_TOKEN });
        if (r && r.stream) {
          const buffer = Buffer.from(await new Response(r.stream).arrayBuffer());
          const contentType = r.blob?.contentType || r.headers?.get?.('content-type') || contentTypeForRef(ref);
          return { buffer, contentType };
        }
        sdkError = `get() returned ${r ? `statusCode ${r.statusCode} with no stream` : 'null (blob not found)'}`;
      } catch (err) {
        sdkError = `${err.name}: ${err.message}`;
      }
      // eslint-disable-next-line no-console
      console.error('[storage] blob SDK read failed, trying a plain fetch', {
        access: blobAccess(),
        host: safeHost(ref),
        error: sdkError,
      });
    }
    const res = await fetch(ref);
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error('[storage] blob fetch failed', { status: res.status, host: safeHost(ref), sdkError });
      throw new Error(
        `לא ניתן לקרוא את הקובץ מהאחסון (${res.status})` +
          (res.status === 401 || res.status === 403
            ? ' — הקובץ פרטי והקריאה דרך ה-SDK נכשלה. הרץ "בדיקת אחסון קבצים" בהגדרות.'
            : '') +
          (sdkError ? ` [${sdkError}]` : ''),
      );
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') || contentTypeForRef(ref) };
  }
  const buffer = fs.readFileSync(path.join(config.uploadsDir, path.basename(ref)));
  return { buffer, contentType: contentTypeForRef(ref) };
}

/** A ref's host, for logs — never the full URL, which is itself the capability to read the blob. */
function safeHost(ref) {
  try {
    return new URL(ref).host;
  } catch {
    return 'local';
  }
}

/**
 * Write a tiny file, read it back, delete it — and report every step.
 *
 * This exists because "the images don't open" is not reproducible from a development machine:
 * uploads clearly work in production (drafts have refs), the read path fails, and nothing is
 * logged. One click here answers which step breaks and with what error, on the real store.
 *
 * @returns {Promise<{ok: boolean, backend: string, access: string, steps: Array<{step: string, ok: boolean, detail: string}>}>}
 */
export async function storageSelfTest() {
  const steps = [];
  const backend = useBlob() ? 'vercel-blob' : 'local-disk';
  const access = useBlob() ? blobAccess() : 'n/a';
  const payload = Buffer.from('ap-control storage self test\n');
  let ref = null;

  try {
    ref = await putBuffer(payload, '.txt', 'text/plain');
    steps.push({ step: 'כתיבה', ok: true, detail: safeHost(ref) });
  } catch (err) {
    steps.push({ step: 'כתיבה', ok: false, detail: `${err.name}: ${err.message}` });
    return { ok: false, backend, access, steps };
  }

  try {
    const { buffer, contentType } = await getObject(ref);
    const same = Buffer.isBuffer(buffer) && buffer.equals(payload);
    steps.push({
      step: 'קריאה',
      ok: same,
      detail: same ? `${buffer.length} בתים · ${contentType}` : `הוחזרו ${buffer?.length ?? 0} בתים במקום ${payload.length}`,
    });
    if (!same) return { ok: false, backend, access, steps };
  } catch (err) {
    steps.push({ step: 'קריאה', ok: false, detail: err.message });
    await del(ref);
    return { ok: false, backend, access, steps };
  }

  await del(ref); // del never throws — a leftover test file is not worth failing the check over
  steps.push({ step: 'מחיקה', ok: true, detail: 'הקובץ הזמני נמחק' });
  return { ok: true, backend, access, steps };
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
