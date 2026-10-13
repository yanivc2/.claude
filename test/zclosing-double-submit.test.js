// בעלים (13/10): "למה זה שמר את אותו הזד 4 פעמים". לחיצות חוזרות על "שמור סגירה" כשהשמירה איטית
// הגישו את אותו טופס כמה פעמים. שתי שכבות: הטופס חוסם הגשה שנייה (footer, data-busy), והשרת לא
// שומר שוב סגירה זהה שנשמרה ב-15 הדקות האחרונות.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZClosing, findRecentDuplicateClosing } from '../src/services/zclosing.js';

const input = (store, over = {}) => ({
  employeeFirst: 'נופר', employeeLast: 'לוי', storeId: store.id, zNumber: '2201', drawerCash: 50000,
  startedAt: '2026-10-13 09:00', counts: { 200: 2 },
  expenses: [{ kind: 'manual', expenseDate: '2026-10-13', payerName: 'נופר', purpose: 'מונית', amount: 7750 }],
  ...over,
});

let server, base, db, o, store;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  store = await firstStore(db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

// One DB for the whole file: freshDb() also swaps the app's global executor, so a second one would
// leave the HTTP tests writing to a different database than the one they assert on.
test('the same closing submitted again is not saved twice; a different one is', async () => {
  const x = db;
  const id1 = await createZClosing(input(store), o, x);
  assert.equal(await findRecentDuplicateClosing(input(store), x), id1);
  const id2 = await createZClosing(input(store), o, x);
  assert.equal(id2, id1, 'the second click returns the first closing');
  assert.equal(Number((await x.one("SELECT COUNT(*) AS n FROM z_closings WHERE z_number = '2201'", [])).n), 1);
  assert.equal(Number((await x.one('SELECT COUNT(*) AS n FROM z_closing_expenses WHERE closing_id = ?', [id1])).n), 1, 'no duplicate cash lines either');
  assert.equal(Number((await x.one('SELECT COUNT(*) AS n FROM z_closing_expenses', [])).n), 1);

  // a real second closing (different count) is still saved
  const id3 = await createZClosing(input(store, { counts: { 200: 3 } }), o, x);
  assert.notEqual(id3, id1);
  // an identical one from long ago is not a double click
  await x.run("UPDATE z_closings SET created_at = '2020-01-01 00:00:00' WHERE z_number = '2201'", []);
  assert.equal(await findRecentDuplicateClosing(input(store), x), null);
});


test('route: a second identical POST redirects with "already saved" and files nothing', async () => {
  const body = new URLSearchParams({
    ctx_store: String(store.id), store_id: String(store.id), employee_first: 'נופר', employee_last: 'לוי',
    z_number: '2202', drawer_cash: '400', started_at: '2026-10-13 09:00', count_200: '2',
  }).toString();
  const post = () => fetch(`${base}/zclosing`, {
    method: 'POST', redirect: 'manual', body,
    headers: { cookie: `session=${createSession(o.id)}; ap_store=${store.id}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const r1 = await post();
  assert.equal(r1.headers.get('location'), '/zclosing?saved=1');
  const r2 = await post();
  assert.equal(r2.headers.get('location'), '/zclosing?saved=1&dup=1');
  assert.equal(Number((await db.one("SELECT COUNT(*) AS n FROM z_closings WHERE z_number = '2202'", [])).n), 1);
  const page = await (await fetch(`${base}/zclosing?saved=1&dup=1`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${store.id}` } })).text();
  assert.match(page, /הסגירה כבר נשמרה/);
});

test('copies already saved are marked "כפול" in the list, so it is clear what to delete', async () => {
  const src = await db.one("SELECT * FROM z_closings WHERE z_number = '2202'", []);
  await db.run(
    `INSERT INTO z_closings (employee_first, employee_last, store_id, z_number, drawer_cash, total_cash, total_expenses, grand_total, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2020-01-01 00:00:00')`,
    [src.employee_first, src.employee_last, src.store_id, src.z_number, src.drawer_cash, src.total_cash, src.total_expenses, src.grand_total],
  );
  const page = await (await fetch(`${base}/zclosing`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${store.id}` } })).text();
  assert.equal((page.match(/⚠️ כפול ×2/g) || []).length, 2, 'both rows of the pair are marked');
});

test('the entry forms opt into the double-submit guard, and the guard respects cancelled submits', () => {
  for (const f of ['src/views/zclosing/index.ejs', 'src/views/zclosing/edit.ejs', 'src/views/reports/_zform.ejs', 'src/views/invoices/new.ejs']) {
    assert.match(fs.readFileSync(f, 'utf8'), /<form [^\n]*data-busy="שומר…"/, f);
  }
  const footer = fs.readFileSync('src/views/partials/footer.ejs', 'utf8');
  assert.match(footer, /if \(e\.defaultPrevented\) return;/, 'a validator that stopped the submit leaves the button usable');
  assert.match(footer, /data-busy-sent/, 'a second submit while the first is in flight is swallowed');
  assert.match(footer, /addEventListener\('pageshow'/, 'Back to the page re-enables the form');
});
