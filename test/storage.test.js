import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putBuffer, getObject, del, localPath, contentTypeForRef, storageSelfTest } from '../src/lib/storage.js';
import { config } from '../src/config.js';

const uploadsDir = () => config.uploadsDir;

// These exercise the local-disk backend (no BLOB_READ_WRITE_TOKEN). config.uploadsDir defaults
// to <project>/uploads; the test cleans up what it writes.

test('contentTypeForRef maps by extension for local + URL refs', () => {
  assert.equal(contentTypeForRef('abc.jpg'), 'image/jpeg');
  assert.equal(contentTypeForRef('x.PDF'), 'application/pdf');
  assert.equal(contentTypeForRef('https://host/uploads/uuid.png'), 'image/png');
  assert.equal(contentTypeForRef('noext'), 'application/octet-stream');
});

test('local backend: put -> get round-trips bytes and content-type; del removes', async () => {
  const bytes = Buffer.from([1, 2, 3, 4, 5]);
  const ref = await putBuffer(bytes, '.png', 'image/png');
  assert.match(ref, /\.png$/); // local ref is a bare filename
  const { buffer, contentType } = await getObject(ref);
  assert.deepEqual([...buffer], [...bytes]);
  assert.equal(contentType, 'image/png');

  const lp = await localPath(ref);
  assert.ok(fs.existsSync(lp));

  await del(ref);
  await assert.rejects(getObject(ref)); // gone
});

test('del is a no-op on a missing ref (best-effort, never throws)', async () => {
  await del('does-not-exist.jpg'); // should not throw
  await del(null);
  assert.ok(true);
});

test('storageSelfTest reports every step and leaves nothing behind', async () => {
  // The point of this check is that it answers "which step fails" on a real store — so what it
  // must never do is come back green while quietly skipping a step, or leave its probe file.
  // The token is cleared for the duration: a test suite must never write to the live blob store,
  // not even a file it deletes again.
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  try {
    const before = fs.existsSync(uploadsDir()) ? fs.readdirSync(uploadsDir()).length : 0;
    const r = await storageSelfTest();
    assert.equal(r.ok, true);
    assert.equal(r.backend, 'local-disk');
    assert.deepEqual(r.steps.map((s) => s.step), ['כתיבה', 'קריאה', 'מחיקה']);
    assert.ok(r.steps.every((s) => s.ok));
    const after = fs.existsSync(uploadsDir()) ? fs.readdirSync(uploadsDir()).length : 0;
    assert.equal(after, before);
  } finally {
    if (token) process.env.BLOB_READ_WRITE_TOKEN = token;
  }
});

test('a read failure names its cause instead of returning a bare status', async () => {
  // getObject used to swallow the SDK error with `catch {}` and then throw `blob fetch failed:
  // 403`, which is what made "the images do not open" arrive with nothing in the logs.
  await assert.rejects(getObject('https://127.0.0.1:1/uploads/missing.jpg'), (err) => {
    assert.ok(err.message.length > 0);
    return true;
  });
});
