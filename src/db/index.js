import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db;

/**
 * Open (or create) the SQLite database, apply the schema, and return the singleton
 * connection. Idempotent — safe to call from multiple modules.
 */
export function getDb() {
  if (db) return db;

  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL'); // safer concurrent reads for the local web app
  db.pragma('foreign_keys = ON');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  return db;
}

/** Close the connection (used by tests). */
export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
