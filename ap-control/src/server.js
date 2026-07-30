import { createApp } from './app.js';
import { getDb } from './db/index.js';
import { seed } from './db/seed.js';
import { config } from './config.js';

// Ensure schema exists and reference data is seeded before serving.
seed(getDb());

const app = createApp();
app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`AP Control פועל: http://localhost:${config.port}`);
});
