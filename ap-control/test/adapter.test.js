import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { freshPgPool } from './helpers.js';
import { initBackend, getBackend, tx, nowTs } from '../src/db/adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function sqliteExecutorDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8'));
  return db;
}

// Run the same Executor-level assertions against both backends, so every service built on the
// adapter is guaranteed dialect-parity.
async function parity(makeExec, label) {
  await test(`adapter parity — ${label}`, async () => {
    const x = await makeExec();

    // insert -> lastInsertRowid
    const ins = await x.run("INSERT INTO companies (name, tax_id) VALUES (?, ?)", ['ACME', '514']);
    assert.ok(ins.lastInsertRowid, 'lastInsertRowid returned');
    const cid = ins.lastInsertRowid;

    // one() returns a single row
    const co = await x.one('SELECT id, name FROM companies WHERE id = ?', [cid]);
    assert.equal(co.name, 'ACME');

    // many() returns all rows
    await x.run("INSERT INTO users (name, role) VALUES (?, ?)", ['בעלים', 'owner']);
    await x.run("INSERT INTO suppliers (name, status) VALUES (?, 'pending')", ['ספק א']);
    await x.run("INSERT INTO suppliers (name, status) VALUES (?, 'approved')", ['ספק ב']);
    const sups = await x.many('SELECT name FROM suppliers ORDER BY name', []);
    assert.equal(sups.length, 2);

    // run() reports changes
    const upd = await x.run("UPDATE suppliers SET status = 'approved' WHERE status = 'pending'", []);
    assert.equal(upd.changes, 1);

    // parametrized timestamp write (replaces strftime) round-trips
    const ts = nowTs();
    await x.run("INSERT INTO audit_log (action, entity_type, timestamp) VALUES (?, ?, ?)", ['test', 'x', ts]);
    const a = await x.one('SELECT timestamp FROM audit_log ORDER BY id DESC LIMIT 1', []);
    assert.equal(a.timestamp, ts);
  });
}

await parity(async () => initBackend({ sqliteDb: sqliteExecutorDb() }), 'sqlite');
await parity(async () => initBackend({ pgPool: freshPgPool() }), 'postgres (pg-mem)');

test('tx commits on success and rolls back on throw (current backend)', async () => {
  // backend is whatever the last initBackend set; re-init sqlite for determinism
  await initBackend({ sqliteDb: sqliteExecutorDb() });
  assert.equal(getBackend(), 'sqlite');
  await tx(async (t) => {
    await t.run("INSERT INTO companies (name) VALUES (?)", ['Committed']);
  });
  const { getExecutor } = await import('../src/db/adapter.js');
  let n = await getExecutor().one('SELECT COUNT(*) AS c FROM companies', []);
  assert.equal(n.c, 1);
  await assert.rejects(
    tx(async (t) => {
      await t.run("INSERT INTO companies (name) VALUES (?)", ['RolledBack']);
      throw new Error('boom');
    }),
    /boom/,
  );
  n = await getExecutor().one('SELECT COUNT(*) AS c FROM companies', []);
  assert.equal(n.c, 1, 'rolled-back insert not persisted');
});
