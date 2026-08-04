import { createApp } from './app.js';
import { initDb, getBackend } from './db/index.js';
import { seed } from './db/seed.js';
import { config } from './config.js';

// In a cloud deployment (DATABASE_URL set) a persistent SESSION_SECRET is mandatory — otherwise
// each instance signs with a different random secret and users are logged out unpredictably, and
// tokens are unforgeable only by luck. Refuse to start rather than run insecurely.
if (process.env.DATABASE_URL && !config.auth.hasExplicitSecret) {
  throw new Error('SESSION_SECRET חובה בפרודקשן (סוד קבוע לחתימת ה-session). הגדר אותו לפני הרצה.');
}

// Initialize the backend (Postgres if DATABASE_URL, else local SQLite), apply schema, seed.
await initDb();
await seed();

const app = createApp();
app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`AP Control פועל: http://localhost:${config.port} (DB: ${getBackend()})`);
});
