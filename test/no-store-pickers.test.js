// בעלים, 17/10: "בהתאמות בנקים עדיין מופיע אפשרות לבחור חנות ולא בסרגל העליון — ביקשתי שלא יהיה אפשרות
// בשום מקום". הבורר היחיד הוא זה שבסרגל העליון (store-banner); אף דף לא מציע בורר חנות/חברה/חשבון משלו.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let ow, st, server, base;
before(async () => {
  const db = await freshDb();
  ow = await owner(db);
  st = await firstStore(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const PAGES = ['/', '/reconciliation', '/payments', '/payments/new', '/invoices', '/invoices/new', '/reports/zreports', '/reports/outstanding',
  '/reports/profitability', '/zclosing', '/employees', '/audit', '/transfers', '/voided-checks', '/tracked-invoices', '/suppliers',
  '/notifications', '/approvals'];
const PICKER = /<select[^>]*name="(store|store_id|company|company_id|account|account_id|zstore|bank_account_id)"/;

const body = (html) => {
  // Everything after the top bar: the banner's own <select> is the one allowed picker.
  const end = html.indexOf('</form>', html.indexOf('class="store-banner'));
  return end > 0 ? html.slice(end) : html;
};

for (const withStore of [true, false]) {
  test(`no page offers its own store/account picker (${withStore ? 'active store' : '"כל החנויות"'})`, async () => {
    const cookie = `session=${createSession(ow.id)}${withStore ? `; ap_store=${st.id}` : ''}`;
    for (const p of PAGES) {
      const html = await (await fetch(base + p, { headers: { cookie } })).text();
      const m = body(html).match(PICKER);
      assert.ok(!m, `${p}: ${m && m[0]}`);
    }
  });
}

test('bank reconciliation: the active store decides the account — its name is shown, not picked', async () => {
  const html = await (await fetch(`${base}/reconciliation`, { headers: { cookie: `session=${createSession(ow.id)}; ap_store=${st.id}` } })).text();
  assert.match(html, /חשבון בנק: <strong>[^<]+<\/strong>/);
  const all = await (await fetch(`${base}/reconciliation`, { headers: { cookie: `session=${createSession(ow.id)}` } })).text();
  assert.match(all, /כדי לראות התאמת בנק, בחר חנות פעילה בסרגל העליון/, 'without a store: points at the top bar, not the first account');
});
