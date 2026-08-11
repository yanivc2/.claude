// Boot the real Express app against a fresh in-memory SQLite DB (schema + seed), sign an owner
// session, and GET a list of pages — asserting each returns 200 and not an error page. Catches
// EJS/template regressions that unit tests miss. Usage: node scripts/smoke.mjs [path ...]
import Database from 'better-sqlite3';
import { initDb } from '../src/db/index.js';
import { seed } from '../src/db/seed.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

const sqliteDb = new Database(':memory:');
const x = await initDb({ sqliteDb });
await seed(x);
const owner = await x.one("SELECT * FROM users WHERE role = 'owner' LIMIT 1", []);
const cookie = 'session=' + encodeURIComponent(createSession(owner.id));

const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

const paths = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['/', '/suppliers', '/suppliers/new', '/reports/zreports', '/reports/profitability',
     '/reports/outstanding', '/reconciliation', '/payments', '/settings', '/invoices'];

let bad = 0;
for (const p of paths) {
  try {
    const res = await fetch(base + p, { headers: { cookie }, redirect: 'manual' });
    const body = res.status < 400 ? await res.text() : '';
    const errored = body.includes('<title>שגיאה') || body.includes('Cannot GET');
    const ok = (res.status === 200 || res.status === 303) && !errored;
    console.log(`${ok ? 'ok ' : 'FAIL'} ${res.status} ${p}`);
    if (!ok) { bad++; if (body) console.log('   ' + body.replace(/\s+/g, ' ').slice(0, 300)); }
  } catch (e) {
    bad++; console.log(`FAIL --- ${p}  ${e.message}`);
  }
}
// One representative supplier edit page (needs a real id).
const sup = await x.one('SELECT id FROM suppliers ORDER BY id LIMIT 1', []);
if (sup) {
  const res = await fetch(`${base}/suppliers/${sup.id}/edit`, { headers: { cookie } });
  const body = await res.text();
  const ok = res.status === 200 && !body.includes('<title>שגיאה');
  console.log(`${ok ? 'ok ' : 'FAIL'} ${res.status} /suppliers/${sup.id}/edit`);
  if (!ok) { bad++; console.log('   ' + body.replace(/\s+/g, ' ').slice(0, 300)); }
}

server.close();
console.log(bad ? `\n${bad} FAILED` : '\nall pages rendered');
process.exit(bad ? 1 : 0);
