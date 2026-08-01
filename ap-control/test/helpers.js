import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { newDb, DataType } from 'pg-mem';
import { seed } from '../src/db/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build a fresh in-memory database with schema + seed for a test. */
export function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf8');
  db.exec(schema);
  seed(db);
  return db;
}

/**
 * Fresh in-memory Postgres (pg-mem) with the Postgres schema applied and to_char registered.
 * Returns a node-postgres-compatible Pool for the async adapter. Used to run the suite against
 * the Postgres dialect without a real server.
 */
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

export function owner(db) {
  return db.prepare("SELECT * FROM users WHERE role = 'owner' LIMIT 1").get();
}
export function secretary(db) {
  return db.prepare("SELECT * FROM users WHERE role = 'secretary' LIMIT 1").get();
}
export function firstStore(db) {
  return db.prepare('SELECT * FROM stores ORDER BY id LIMIT 1').get();
}
export function accountForStore(db, storeId) {
  return db.prepare('SELECT * FROM bank_accounts WHERE store_id = ?').get(storeId);
}
