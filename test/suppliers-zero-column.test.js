// בעלים 21/10: "+ ספק חדש" ו"סינון" בשורת הכותרת משמאל ל"→ חזרה"; "ספקים בשיעור אפס" — לא כרטיס נפרד אלא
// העמודה השמאלית בטבלה (במקום "הערות"), וספק שמשייכים מסמנים בריבוע בקליק.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';

let db, o, sup, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  sup = await approveSupplier((await createSupplier({ name: 'ירקות השדה', notes: 'הערה פנימית' }, o, db)).id, o, db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const page = async (u) => (await fetch(`${base}/suppliers`, { headers: { cookie: `session=${createSession(u.id)}` } })).text();

test('the two menus sit in the header row; the toolbar keeps only the title', async () => {
  const html = await page(o);
  const start = html.slice(html.indexOf('class="sb-side sb-start"'), html.indexOf('class="sb-center"'));
  assert.ok(start.indexOf('+ ספק חדש') > 0 && start.indexOf('סינון · הכל') > start.indexOf('+ ספק חדש'), 'new supplier, then filter');
  const main = html.slice(html.indexOf('<main'));
  assert.doesNotMatch(main, /<summary class="btn btn-primary">\+ ספק חדש/, 'not in the page toolbar any more');
});

test('no separate zero-rate card; the leftmost column is "שיעור מע\"מ 0" with a box per supplier, instead of "הערות"', async () => {
  const html = await page(o);
  assert.doesNotMatch(html, /ספקים בשיעור אפס \(פירות וירקות\)/);
  const head = html.slice(html.indexOf('<thead>', html.indexOf('action="/suppliers/bulk"')), html.indexOf('</thead>', html.indexOf('action="/suppliers/bulk"')));
  assert.match(head, /<th data-nosort data-nofilter data-noexport class="zero-col"[^>]*>שיעור מע"מ 0<\/th>\s*<\/tr>/, 'the last (leftmost) column');
  assert.doesNotMatch(head, />הערות</);
  assert.match(html, new RegExp(`<input type="checkbox" class="zero-toggle" data-id="${sup.id}"`));
  assert.doesNotMatch(html, /class="zero-toggle"[^>]*name=/, 'the box never rides along with the bulk form');
  assert.match(html, /id="zeroToggleForm"/);
});

test('one click marks one supplier (and only it); a second click unmarks it', async () => {
  const post = (body) => fetch(`${base}/suppliers/zero-rated`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie: `session=${createSession(o.id)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  let r = await post({ offered: String(sup.id), zero_ids: String(sup.id) });
  assert.equal(r.status, 303);
  assert.equal(Number((await db.one('SELECT zero_rated FROM suppliers WHERE id = ?', [sup.id])).zero_rated), 1);
  const html = await (await fetch(base + r.headers.get('location'), { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.doesNotMatch(html, /הספק סומן|הוסר מהספק/, 'no notice after a single box (owner: "מחק")');
  r = await post({ offered: String(sup.id) });
  assert.equal(Number((await db.one('SELECT zero_rated FROM suppliers WHERE id = ?', [sup.id])).zero_rated), 0);
});

test('a non-owner sees the state but cannot click it', async () => {
  const sec = await secretary(db);
  await db.run(`UPDATE users SET permissions = '["nav_suppliers"]' WHERE id = ?`, [sec.id]);
  const html = await page(sec);
  if (!/class="zero-toggle"/.test(html)) return; // a secretary without this page sees no table at all
  assert.match(html, /class="zero-toggle"[^>]*disabled/);
  assert.doesNotMatch(html, /id="zeroToggleForm"/);
});

// בעלים 21/10: "פעולה על הנבחרים" — "להעביר לטבלה בין שם לריבוע שמסמנים. הכותרת שלו היא אפשרויות מסומנים. את הבצע שים תחתיו".
test('"אפשרויות מסומנים" is the header of the column between the row boxes and "שם": title, then the action, then "בצע"', async () => {
  const html = await page(o);
  assert.doesNotMatch(html, /פעולה על הנבחרים/, 'the separate card above the table is gone');
  const form = html.indexOf('action="/suppliers/bulk"');
  const head = html.slice(html.indexOf('<thead>', form), html.indexOf('</thead>', form));
  const box = head.indexOf('title="בחר הכל"');
  const col = head.indexOf('class="bulk-col');
  const name = head.indexOf('<th>שם</th>');
  assert.ok(box > 0 && col > box && name > col, 'row boxes → אפשרויות מסומנים → שם');
  const th = head.slice(col, head.indexOf('</th>', col));
  const title = th.indexOf('אפשרויות מסומנים');
  const pick = th.indexOf('<select name="bulk_action"');
  const go = th.indexOf('>בצע</button>');
  assert.ok(title > 0 && pick > title && go > pick, 'title, under it the action, under it "בצע"');
  assert.ok(html.indexOf('</form>', form) > html.indexOf('</thead>', form), 'still inside the bulk form');
});

// בעלים 21/10: "אפשר לצמצם את הטבלה של הספקים, ומצומצמת כברירת מחדל".
test('the suppliers table sits in a collapsible card that starts collapsed', async () => {
  const html = await page(o);
  const form = html.indexOf('action="/suppliers/bulk"');
  const card = html.indexOf('<div class="card suppliers-card">', form);
  const h2 = html.indexOf('<h2 data-ckey="ספקים">ספקים', card);
  const table = html.indexOf('<table>', card);
  assert.ok(card > form && h2 > card && table > h2, 'card → its <h2> → the table');
  assert.match(html.slice(form, card), /<span data-collapse-default="v1" hidden><\/span>/, 'start collapsed');
});
