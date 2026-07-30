import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
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
