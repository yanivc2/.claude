import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { initBackend, getExecutor, getBackend, getRawSqlite, execScript, execScriptEach } from './adapter.js';
import { migrate } from './migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let ready = false;

/**
 * Initialize the data layer: pick the backend (Postgres if DATABASE_URL, else SQLite), apply
 * the matching schema, and (SQLite only) run migrations. Returns the shared Executor.
 * Tests pass { sqliteDb } or { pgPool } to inject an in-memory backend.
 * @returns {Promise<import('./adapter.js').Executor>}
 */
export async function initDb(opts = {}) {
  if (!opts.pgPool && !opts.sqliteDb && !process.env.DATABASE_URL) {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }
  const x = await initBackend(opts);
  if (getBackend() === 'pg') {
    await execScript(fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8'));
  } else {
    await execScript(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    migrate(getRawSqlite()); // SQLite-only, idempotent
  }
  ready = true;
  return x;
}

export function isReady() {
  return ready;
}

/**
 * Re-apply the schema against the already-connected backend, on demand. Idempotent:
 * CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS, so it only fills in what is missing
 * (e.g. new columns after a deploy). Used by the owner-triggered "DB upgrade" button so the
 * live Neon DB can be brought up to date without a terminal. Never drops or clears data.
 */
export async function upgradeSchema() {
  if (getBackend() === 'pg') {
    // Resilient: run each statement on its own so one failing statement can't roll back the
    // whole file (Postgres runs a multi-statement query as a single implicit transaction).
    return execScriptEach(fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8'), { tolerant: true });
  }
  await execScript(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  migrate(getRawSqlite());
  return [];
}

/**
 * Connect to the backend WITHOUT applying the schema — for serverless request handlers, where
 * the schema is applied once by the deploy-time setup step (`npm run db:setup`), not on every
 * cold start. Idempotent: only initializes the pool the first time.
 */
export async function connectDb(opts = {}) {
  if (ready) return getExecutor();
  const x = await initBackend(opts);
  ready = true;
  return x;
}

export { getExecutor, getBackend } from './adapter.js';
