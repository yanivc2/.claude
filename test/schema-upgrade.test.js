import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { execScriptEach, getExecutor } from '../src/db/adapter.js';

// Guards the fix for "column X does not exist after עדכן מסד נתונים": on Postgres a multi-statement
// query runs as ONE implicit transaction, so a single failing statement used to roll back every
// ADD COLUMN in schema.pg.sql. execScriptEach runs each statement on its own and tolerates failures.
test('execScriptEach applies every good statement even when one fails', async () => {
  await freshDb(); // initializes the backend + schema
  const x = getExecutor();
  const sql = [
    'ALTER TABLE users ADD COLUMN probe_a TEXT',
    'SELECT * FROM a_table_that_does_not_exist_zzz', // this one fails
    'ALTER TABLE users ADD COLUMN probe_b TEXT',
  ].join(';\n');

  const failures = await execScriptEach(sql, { tolerant: true });
  assert.equal(failures.length, 1, 'exactly the one bad statement is reported');

  // Both columns were added despite the failing statement in the middle — would throw if missing.
  await x.run("UPDATE users SET probe_a = 'x', probe_b = 'y'");
  const row = await x.one('SELECT probe_a, probe_b FROM users LIMIT 1', []);
  assert.equal(row.probe_a, 'x');
  assert.equal(row.probe_b, 'y');
});

test('execScriptEach without tolerant rethrows', async () => {
  await freshDb();
  await assert.rejects(() => execScriptEach('SELECT * FROM nope_zzz', {}));
});
