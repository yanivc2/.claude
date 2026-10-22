// בעלים 22/10, דוחות Z ← "רשומות Z אחרונות": "ששתי הכפתורים לוואטסאפ ומחק יהיו באותה שורה — תקטין את הכפתור של
// הוואטסאפ ושים לו לוגו של וואטסאפ".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner, firstStore } from './helpers.js';
import { createZReport } from '../src/services/zreports.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let o, st, server, base, db;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  await createZReport({ storeId: st.id, zNumber: '2180', zDate: '2026-10-10', dailyTotal: 6629856, drawerCash: 2025500, drawerCredit: 4604356 }, o, db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('WhatsApp is a small logo button sharing one line with "מחק"', async () => {
  const html = await (await fetch(`${base}/reports/zreports`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
  const acts = html.match(/<span class="zr-row-acts">[\s\S]*?<\/span>\s*<\/td>/);
  assert.ok(acts, 'both buttons sit in one .zr-row-acts');
  assert.match(acts[0], /class="btn btn-secondary small wa-icon-btn"[\s\S]*href="https:\/\/wa\.me\/\?text=/);
  assert.match(acts[0], /aria-label="שלח בוואטסאפ"/, 'the name lives in the accessible label, not as text');
  assert.match(acts[0], /<svg class="wa-logo"/);
  assert.doesNotMatch(acts[0], /📲 וואטסאפ/);
  assert.match(acts[0], />מחק<\/button>/);
  const css = readFileSync(new URL('../src/public/nocturne.css', import.meta.url), 'utf8');
  assert.match(css, /main\.page \.zr-row-acts \{ display: inline-flex;[^}]*flex-wrap: nowrap; \}/);
});
