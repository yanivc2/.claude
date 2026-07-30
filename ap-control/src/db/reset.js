import fs from 'node:fs';
import { config } from '../config.js';
import { getDb, closeDb } from './index.js';
import { seed } from './seed.js';

// Danger: wipes the SQLite file and re-creates schema + seed. Local dev convenience only.
for (const suffix of ['', '-wal', '-shm']) {
  const p = config.dbPath + suffix;
  if (fs.existsSync(p)) fs.rmSync(p);
}

const db = getDb();
seed(db);
closeDb();

// eslint-disable-next-line no-console
console.log(`Database reset and seeded at ${config.dbPath}`);
