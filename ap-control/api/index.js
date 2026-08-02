// Vercel serverless entry point. Vercel routes every request here (see vercel.json). The
// Express app is created once per warm instance; the DB pool is connected lazily on the first
// request (connectDb — no schema apply; that is a one-time `npm run db:setup` at deploy time).

import { createApp } from '../src/app.js';
import { connectDb } from '../src/db/index.js';

const app = createApp();

let bootPromise = null;
function boot() {
  if (!bootPromise) bootPromise = connectDb();
  return bootPromise;
}

export default async function handler(req, res) {
  try {
    await boot();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('DB connect failed:', err);
    res.statusCode = 500;
    res.end('Database connection error');
    return;
  }
  app(req, res);
}
