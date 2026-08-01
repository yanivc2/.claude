import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { initBackend, getExecutor, getBackend, getRawSqlite, execScript } from './adapter.js';
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

export { getExecutor, getBackend } from './adapter.js';
