import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { newDb, DataType } from 'pg-mem';
import { initDb } from '../src/db/index.js';
import { initBackend } from '../src/db/adapter.js';
import { seed } from '../src/db/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build a fresh in-memory SQLite database (schema + seed) and return the async Executor.
 * Pass the returned executor to service functions as their `x` argument.
 */
export async function freshDb() {
  // TEST_PG=1 runs the entire suite against the Postgres dialect (pg-mem) instead of SQLite.
  if (process.env.TEST_PG === '1') return freshPgDb();
  const sqliteDb = new Database(':memory:');
  const x = await initDb({ sqliteDb });
  await seed(x);
  return x;
}

/** pg-mem Pool with the Postgres schema applied and to_char registered (for the adapter). */
export function freshPgPool() {
  const db = newDb();
  db.public.registerFunction({
    name: 'to_char',
    args: [DataType.timestamptz, DataType.text],
    returns: DataType.text,
    implementation: (ts) => new Date(ts).toISOString().slice(0, 19).replace('T', ' '),
  });
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.pg.sql'), 'utf8');
  db.public.none(schema);
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

/**
 * Fresh in-memory Postgres (pg-mem) database (schema + seed) as an async Executor.
 * The schema is applied via pg-mem's native loader (freshPgPool) because pg-mem's Pool.query
 * path doesn't fully support IDENTITY DDL — real Postgres/Neon loads it via initDb.execScript.
 */
export async function freshPgDb() {
  const x = await initBackend({ pgPool: freshPgPool() });
  await seed(x);
  return x;
}

export async function owner(x) {
  return x.one("SELECT * FROM users WHERE role = 'owner' LIMIT 1", []);
}
export async function secretary(x) {
  return x.one("SELECT * FROM users WHERE role = 'secretary' LIMIT 1", []);
}
export async function firstStore(x) {
  return x.one('SELECT * FROM stores ORDER BY id LIMIT 1', []);
}
export async function accountForStore(x, storeId) {
  return x.one('SELECT * FROM bank_accounts WHERE store_id = ?', [storeId]);
}
