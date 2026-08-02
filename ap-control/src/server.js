import { createApp } from './app.js';
import { initDb, getBackend } from './db/index.js';
import { seed } from './db/seed.js';
import { config } from './config.js';

// Initialize the backend (Postgres if DATABASE_URL, else local SQLite), apply schema, seed.
await initDb();
await seed();

const app = createApp();
app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`AP Control פועל: http://localhost:${config.port} (DB: ${getBackend()})`);
});
