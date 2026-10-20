// בעלים, 20/10: "תסדר גם את מסך עריכת סגירת Z" — כמו הטופס החדש (views/zclosing/index.ejs): עובד · Z ·
// מזומן מגירה בשורה אחת, בלי הכותרת "ספירת מזומן", הוצאות פתוחות תמיד, "ייצוא" ליד השמירה. מה שיש רק
// בעריכה — לפי הבחירה שלו: החנות בשורה הקטנה מעל הטופס עם "העבר לחנות אחרת", ו"מחק סגירה" באותה שורה
// של השמירה, משמאל ל"ייצוא".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZClosing, getZClosing } from '../src/services/zclosing.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const view = read('src/views/zclosing/edit.ejs').replace(/<%#[\s\S]*?%>/g, '');

test('edit: the store sits in the small line above the form, then counter · Z · drawer in one equal row', () => {
  const meta = view.indexOf('<p class="muted edit-meta">');
  const row = view.indexOf('<div class="row zc-top-row">');
  assert.ok(meta > 0 && meta < row, 'the small line comes first, inside the form');
  assert.match(view.slice(meta, row), /include\('\.\.\/partials\/_storeField', \{ currentStoreId: closing\.store_id \}\)[\s\S]*נשמר:/);
  const top = view.slice(row, view.indexOf('איזון קופות (ספירת'));
  const at = (t) => top.indexOf(t);
  assert.ok(at('עובד (מבצע הספירה)') > 0 && at('עובד (מבצע הספירה)') < at('מספר Z') && at('מספר Z') < at('סה"כ מזומן מגירה'),
    'counter first (= right in RTL), then Z number, then drawer cash — all before איזון קופות');
  assert.doesNotMatch(top, /_storeField/, 'no store field in the row');
});

test('edit: no "ספירת מזומן" title, expenses always open, save · export · delete in one row', () => {
  assert.doesNotMatch(view, /<h3[^>]*>ספירת מזומן<\/h3>/);
  assert.match(view, /<div class="cx-section">\s*<h3[^>]*>הוצאות מזומן<\/h3>/);
  assert.match(view, /<table class="no-filter" data-count-adjust data-export-into="zc-export">/);
  assert.match(view,
    /<div class="zc-save-row"><button type="submit">💾 שמור שינויים<\/button><span id="zc-export"><\/span><button type="submit" class="danger" formaction="\/zclosing\/<%= closing\.id %>\/delete"/,
    'RTL: save right, export left of it, delete left of export');
});

let db, o, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

const cookie = (storeId) => `session=${createSession(o.id)}; ap_store=${storeId}`;

test('the owner sees "חנות: X" as text and a hidden move picker that still posts the current store', async () => {
  const store = await db.one("SELECT id FROM stores WHERE name = 'מידנייט'", []);
  const id = await createZClosing(
    { employeeFirst: 'נועה', employeeLast: 'כהן', zNumber: '5120', drawerCash: 10000, storeId: store.id, counts: {}, registers: [], expenses: [] },
    o, db,
  );
  const html = await (await fetch(`${base}/zclosing/${id}`, { headers: { cookie: cookie(store.id) } })).text();
  const meta = html.slice(html.indexOf('class="muted edit-meta"'), html.indexOf('class="row zc-top-row"'));
  assert.match(meta, /<span class="sf-inline">חנות: <strong>מידנייט · /);
  assert.match(meta, /<span class="sf-move-link">· <button type="button" class="sf-move-btn"[^>]*>העבר לחנות אחרת<\/button><\/span>/,
    'the separator hides together with the link');
  assert.match(meta, /<span class="sf-move" hidden>\s*<select name="store_id" required/);
  assert.match(meta, new RegExp(`<option value="${store.id}" selected>`), 'the hidden picker holds the closing\'s own store');
  assert.doesNotMatch(html, /<label>חנות<\/label>/, 'no store field in the form any more');

  // Saving without opening the picker is an update, not a move.
  const body = new URLSearchParams({
    ctx_store: String(store.id), store_id: String(store.id), employee_first: 'נועה', employee_last: 'כהן', z_number: '5121', drawer_cash: '100',
  });
  const res = await fetch(`${base}/zclosing/${id}`, {
    method: 'POST', redirect: 'manual', body,
    headers: { cookie: cookie(store.id), 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(res.status, 303);
  assert.equal(new URLSearchParams(res.headers.get('location').split('?')[1]).get('notice'), 'הסגירה עודכנה.');
  const after = await getZClosing(id, db);
  assert.equal(Number(after.store_id), store.id);
  assert.equal(after.z_number, '5121');
});
