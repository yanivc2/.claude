// בעלים (2026-10-11): "צור בקשת העברה" בלי חשבונית מסומנת לא נדחה ב"יש לבחור חשבונית" — הוא פותח
// חשבונית חדשה שאמצעי התשלום שלה כבר "העברה", כדי להזין את האסמכתה והתאריך כמו פעם.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let server, base, db, o, store;
const ck = (uid) => `session=${createSession(uid)}; ap_store=${store.id}`;
const post = (p, uid, body) => fetch(`${base}${p}`, {
  method: 'POST', redirect: 'manual', headers: { cookie: ck(uid), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
const get = async (p, uid) => (await fetch(`${base}${p}`, { headers: { cookie: ck(uid) } })).text();

before(async () => {
  db = await freshDb();
  o = await owner(db);
  store = await db.one('SELECT * FROM stores ORDER BY id LIMIT 1', []);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('nothing ticked → redirected to a new invoice with "העברה" preselected', async () => {
  const r = await post('/transfers', o.id, { note: '' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/invoices/new?pay=transfer');
});

test('the new-invoice form arrives with the transfer method selected and its fields', async () => {
  const html = await get('/invoices/new?pay=transfer', o.id);
  assert.match(html, /<option value="transfer" selected>העברה<\/option>/);
  assert.match(html, /name="transfer_ref"/);
  assert.match(html, /חשבונית חדשה בתשלום בהעברה/, 'says why the method is already set');
  const plain = await get('/invoices/new', o.id);
  assert.ok(!/<option value="transfer" selected>/.test(plain), 'without ?pay the method stays empty');
});

test('only "transfer" is honoured from the query', async () => {
  const html = await get('/invoices/new?pay=cash', o.id);
  assert.ok(!/<option value="cash" selected>/.test(html));
});

test('a user without the invoices page still gets the plain refusal, not a dead link', async () => {
  const ins = await db.run(
    "INSERT INTO users (name, role, username, permissions) VALUES ('העברות בלבד', 'secretary', 'tronly', ?)",
    [JSON.stringify(['nav_transfers'])],
  );
  const r = await post('/transfers', ins.lastInsertRowid, { note: '' });
  assert.notEqual(r.status, 303);
  assert.match(await r.text(), /יש לבחור לפחות חשבונית אחת/);
});

test('the transfers page explains what the button does with nothing ticked', async () => {
  const html = await get('/transfers', o.id);
  assert.ok(html.includes('לא סימנת חשבונית? הכפתור יפתח חשבונית חדשה') || html.includes('/invoices/new?pay=transfer'));
});
