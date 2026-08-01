import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putBuffer, getObject, del, localPath, contentTypeForRef } from '../src/lib/storage.js';

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
