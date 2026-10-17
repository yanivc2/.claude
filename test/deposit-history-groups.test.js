// בעלים, 17/10: "בהיסטוריית הפקדות צריך להציג את מה שלא הופקד, ואפשר לעשות את האפשרות למטה כמו שצילמתי"
// (צילום: "▸ סומנו כטופלו (30)" / "▸ הותאמו לאחרונה (5)"). מה שלא הופקד פתוח; השאר בקבוצות מכווצות.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let o, st, server, base;
before(async () => {
  const x = await freshDb();
  o = await owner(x);
  st = await firstStore(x);
  const acct = await accountForStore(x, st.id);
  const tx = Number((await x.run("INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference) VALUES (?, '2026-10-02', 50000, 'הפקדה', '8001')", [acct.id])).lastInsertRowid);
  for (const [bag, dep, m] of [['8001', 1, tx], ['8002', 1, null], ['8004', 0, null]]) {
    await x.run('INSERT INTO deposits (store_id, deposit_date, bag_number, amount, deposited, matched_txn_id, created_by) VALUES (?, ?, ?, 50000, ?, ?, ?)',
      [st.id, '2026-10-0' + bag.slice(-1), bag, dep, m, o.id]);
  }
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('dashboard history: not-deposited rows open, the rest in collapsed groups at the bottom', async () => {
  const html = await (await fetch(`${base}/`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
  const card = html.slice(html.indexOf('היסטוריית הפקדות'), html.indexOf('</table>', html.indexOf('היסטוריית הפקדות')));
  assert.match(card, /<table class="cx-grouped">/, 'no column sort here — it would mix the groups');
  const open = card.indexOf('>8004<'), gDep = card.indexOf('הופקדו — ממתינות לבנק (1)'), dep = card.indexOf('>8002<'),
    gMat = card.indexOf('הותאמו בבנק (1)'), mat = card.indexOf('>8001<');
  assert.ok(open > 0 && open < gDep && gDep < dep && dep < gMat && gMat < mat, 'order: open · deposited group · matched group');
  assert.match(card, /<tr class="cx-done cx-g-deposited">/);
  assert.match(card, /<tr class="cx-done cx-g-matched">/);
});

test('the group toggle lives in the global footer, and a column filter opens the groups too', () => {
  const footer = readFileSync(new URL('../src/views/partials/footer.ejs', import.meta.url), 'utf8');
  assert.match(footer, /closest\('\.cx-group-toggle'\)/);
  assert.match(footer, /t\.closest\('\.filter-row'\)/, 'filtering a column must reach rows inside a closed group');
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /table\.cx-grouped\.show-deposited tr\.cx-g-deposited/);
});
