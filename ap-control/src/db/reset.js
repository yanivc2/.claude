import fs from 'node:fs';
import { config } from '../config.js';
import { initDb, getBackend } from './index.js';
import { seed } from './seed.js';

// Danger: wipes the SQLite file and re-creates schema + seed. Local dev convenience only.
// (Postgres/Neon has no local file to remove — for a cloud reset, drop the tables there.)
for (const suffix of ['', '-wal', '-shm']) {
  const p = config.dbPath + suffix;
  if (fs.existsSync(p)) fs.rmSync(p);
}

await initDb();
await seed();

// eslint-disable-next-line no-console
console.log(`Database reset and seeded (backend: ${getBackend()}) at ${config.dbPath}`);
