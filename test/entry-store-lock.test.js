// כלל הבעלים (2026-10-04): אין בורר חנות בטופסי הזנה. ההזנה נעשית תמיד בחנות הפעילה; בלי חנות
// פעילה הטופס מוחלף ב"בחר חנות"; וטופס שנפתח לחנות אחת ונשלח אחרי שהוחלפה בלשונית אחרת — נדחה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let server, base, db, o;
const ck = (store) => `session=${createSession(o.id)}${store ? `; ap_store=${store}` : ''}`;
const get = async (p, store) => (await fetch(`${base}${p}`, { headers: { cookie: ck(store) } })).text();
const post = (p, store, body) => fetch(`${base}${p}`, {
  method: 'POST', redirect: 'manual', headers: { cookie: ck(store), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});

before(async () => {
  db = await freshDb();
  o = await owner(db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const FORMS = [
  ['/reports/zreports', 'data-zform', 'דוח Z'],
  ['/invoices/new', 'action="/invoices"', 'חשבונית'],
  ['/zclosing', 'action="/zclosing"', 'סגירת Z'],
  ['/employees', 'action="/employees/salary"', 'תשלום שכר'],
  ['/reports/profitability', 'action="/reports/profitability/revenue-import"', 'דוח פדיון'],
  ['/payments/new', 'onsubmit="return validateAdvance(this)"', 'תשלום על החשבון'],
];

test('no active store ("כל החנויות") → every entry form is replaced by "choose a store"', async () => {
  for (const [p, form, what] of FORMS) {
    const html = await get(p, null);
    assert.ok(!html.includes(form), `${p}: the entry form is not offered without an active store`);
    assert.ok(html.includes(`כדי להזין ${what}, בחר חנות פעילה`), `${p}: says what to do instead`);
  }
});

test('with an active store → the form is bound to it (hidden store_id + ctx_store), no picker', async () => {
  for (const [p, form] of FORMS) {
    const html = await get(p, 3);
    assert.ok(html.includes(form), `${p}: the entry form is offered`);
    const f = html.slice(html.indexOf(form), html.indexOf('</form>', html.indexOf(form)));
    assert.match(f, /name="ctx_store" value="3"/, `${p}: carries the store it was opened for`);
    assert.ok(!/<select name="store_id"/.test(f), `${p}: no store picker in the form`);
  }
});

test('a form opened for store 3 and posted after switching to 4 is refused — nothing written', async () => {
  const before = (await db.one('SELECT COUNT(*) AS n FROM z_reports', [])).n;
  const r = await post('/reports/zreports', 4, {
    ctx_store: '3', store_id: '3', z_number: '5501', z_date: '2026-10-04', daily_total: '100', drawer_cash: '100', drawer_credit: '0',
  });
  assert.equal(r.status, 409);
  const html = await r.text();
  assert.match(html, /החנות הפעילה הוחלפה/);
  assert.match(html, /מידנייט/, 'names the store the form was opened for');
  assert.match(html, /data-store="3"/, 'offers to switch back and return to the filled form');
  assert.equal((await db.one('SELECT COUNT(*) AS n FROM z_reports', [])).n, before);
  // and "כל החנויות" in the other tab is a mismatch too
  assert.equal((await post('/reports/zreports', null, { ctx_store: '3', store_id: '3' })).status, 409);
});

test('multipart forms are guarded too (new invoice)', async () => {
  const fd = new FormData();
  fd.set('ctx_store', '3'); fd.set('store_id', '3'); fd.set('supplier_id', '1');
  const r = await fetch(`${base}/invoices`, { method: 'POST', redirect: 'manual', headers: { cookie: ck(4) }, body: fd });
  assert.equal(r.status, 409);
});

test('a register in איזון קופות always belongs to the closing\'s store', async () => {
  const r = await post('/zclosing', 3, {
    ctx_store: '3', store_id: '3', employee_first: 'רון', employee_last: 'לוי', z_number: '7701', drawer_cash: '100',
    started_at: '2026-10-04 09:00', count_100: '1', 'reg_number[]': '1', 'reg_store[]': '4', 'reg_count_100[]': '1',
  });
  assert.ok([302, 303].includes(r.status), `saved (${r.status})`);
  const c = await db.one("SELECT registers FROM z_closings WHERE z_number = '7701'", []);
  const regs = JSON.parse(c.registers || '[]');
  assert.ok(regs.length >= 1);
  for (const g of regs) assert.equal(Number(g.storeId ?? g.store_id), 3, 'a posted reg_store of another branch is ignored');
});

// סריקת מקור: <select name="store_id"> מותר רק במקומות שאינם הזנה לחנות.
test('no <select name="store_id"> in any entry view', () => {
  const ALLOWED = new Set([
    'partials/header.ejs',      // בורר החנות הפעילה עצמו
    'suppliers/edit.ejs',       // חשבון בנק של ספק לפי חנות — שיוך, לא הזנה
    'partials/_storeField.ejs', // שדה החנות בעריכה: בורר "העבר לחנות" רק לבעלי view_all_stores
    'partials/_needStore.ejs',  // מחליף את החנות הפעילה, לא שדה של טופס
  ]);
  const root = path.join(process.cwd(), 'src/views');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(root).filter((f) => f.endsWith('.ejs'))) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    assert.ok(!/<select name="store_id"/.test(fs.readFileSync(f, 'utf8')), `${rel}: entry forms take the active store, never a picker`);
  }
});
