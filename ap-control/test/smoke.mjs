// Live smoke test: boot the app, log in, and render the new/redesigned pages.
// Run with: node test/smoke.mjs   (writes a throwaway SQLite DB under data/, gitignored)
// Env (DB_PATH) must be set BEFORE the modules that read config are imported, so the app
// modules are pulled in dynamically below.
process.env.DB_PATH = process.env.DB_PATH || `data/smoke-${Date.now()}.sqlite`;

const { initDb } = await import('../src/db/index.js');
const { seed } = await import('../src/db/seed.js');
const { createApp } = await import('../src/app.js');

await initDb();
await seed();
const app = createApp();
const server = app.listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

function cookieFrom(res) {
  const sc = res.headers.get('set-cookie') || '';
  return sc.split(';')[0];
}

async function login(username, password) {
  const res = await fetch(`${base}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
    redirect: 'manual',
  });
  const cookie = cookieFrom(res);
  if (!cookie.startsWith('session=')) throw new Error(`login failed for ${username} (status ${res.status})`);
  return cookie;
}

async function get(path, cookie) {
  const res = await fetch(`${base}${path}`, { headers: { cookie }, redirect: 'manual' });
  const body = await res.text();
  return { status: res.status, body };
}

let failures = 0;
function check(name, cond, extra = '') {
  const ok = !!cond;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
}

const owner = await login(process.env.OWNER_USERNAME || 'owner', process.env.OWNER_PASSWORD || 'owner1234');

// Dashboard (redesigned, with transfers widget)
let r = await get('/', owner);
check('dashboard 200', r.status === 200, `status ${r.status}`);
check('dashboard has blueprint font link', r.body.includes('Barlow+Condensed'));
check('dashboard shows transfers tile', r.body.includes('העברות מתוזמנות'));
check('dashboard quick action for transfer', r.body.includes('/transfers/new'));

// Transfers list
r = await get('/transfers', owner);
check('transfers list 200', r.status === 200, `status ${r.status}`);
check('transfers list title', r.body.includes('העברות בנקאיות'));

// Transfers new form
r = await get('/transfers/new', owner);
check('transfers new 200', r.status === 200, `status ${r.status}`);
check('transfers new has account select', r.body.includes('bank_account_id'));

// Create a transfer
const acct = await (await import('../src/db/adapter.js')).getExecutor().one('SELECT id FROM bank_accounts ORDER BY id LIMIT 1', []);
const createRes = await fetch(`${base}/transfers`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie: owner },
  body: new URLSearchParams({
    bank_account_id: String(acct.id), payee: 'חברת החשמל', amount: '2180.50',
    transfer_date: '2026-08-05', reference: 'REF-SMOKE', recurrence: 'monthly', match_type: 'none',
  }),
  redirect: 'manual',
});
check('create transfer redirects', createRes.status === 303, `status ${createRes.status}`);

r = await get('/transfers', owner);
check('created transfer appears', r.body.includes('חברת החשמל'));
check('created transfer amount formatted', r.body.includes('2,180.50'));

// A couple of existing pages still render under the new CSS
for (const p of ['/invoices', '/payments', '/transfers/new', '/salaries', '/salaries/new', '/pension', '/pension/new', '/reconciliation', '/suppliers', '/reports/outstanding', '/reports/purchases', '/reports/profitability', '/settings']) {
  const rr = await get(p, owner);
  check(`page ${p} renders`, rr.status === 200, `status ${rr.status}`);
}

server.close();
console.log(failures ? `\n${failures} FAILURES` : '\nALL SMOKE CHECKS PASSED');
process.exit(failures ? 1 : 0);
