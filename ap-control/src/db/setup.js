// One-time database setup for a deployment: apply the schema and seed reference data.
// Run once against your cloud database (Neon) after setting DATABASE_URL:  npm run db:setup
// Idempotent — safe to re-run (CREATE TABLE IF NOT EXISTS + seed skips existing rows).

import { initDb, getBackend } from './index.js';
import { seed } from './seed.js';

await initDb();
await seed();
// eslint-disable-next-line no-console
console.log(`Schema applied and seeded (backend: ${getBackend()}).`);
process.exit(0);
