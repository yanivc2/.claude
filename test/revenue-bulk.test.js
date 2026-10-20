// בעלים 20/10: "דוח פדיון תקופתי של כמה חנויות בבת אחת — קליטה לפי שם החנות שמודפס בדוח", בהגדרות. הכותרות כאן
// נמדדו מארבעת דוחות התקופה האמיתיים (01/10–16/10): ה-PDF מדפיס את השם המשפטי, לא את שם החנות באפליקציה.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { resolveStoreByTitle, storeTitleConflict } from '../src/lib/revenueIngest.js';
import { importRevenueFiles } from '../src/services/revenueReports.js';

const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));
const STORES = [{ id: 1, name: "ג'וניור" }, { id: 2, name: 'סופר על הדרך' }, { id: 3, name: 'מידנייט' }, { id: 4, name: 'פינק רשל"צ' }];

test('the printed (legal) names of the four real period reports resolve to their stores', () => {
  assert.equal(resolveStoreByTitle(STORES, 'מידנייט').id, 3);
  assert.equal(resolveStoreByTitle(STORES, "ג'וניור בעיר").id, 1);
  assert.equal(resolveStoreByTitle(STORES, 'פינק מרקט י. ר. בע"מ').id, 4, 'by the distinctive word "פינק"');
  assert.equal(resolveStoreByTitle(STORES, 'על הדרך 24 שעות בע"מ').id, 2, 'by "הדרך" — "24", "שעות", "בע"מ" are not names');
});

test('never a guess: no shared word, or two stores sharing it → null', () => {
  assert.equal(resolveStoreByTitle(STORES, 'שוק העיר בע"מ'), null);
  assert.equal(resolveStoreByTitle(STORES, 'בע"מ 24 שעות'), null, 'only non-identifying words');
  assert.equal(resolveStoreByTitle([{ id: 1, name: 'פינק צפון' }, { id: 2, name: 'פינק דרום' }], 'פינק מרקט בע"מ'), null);
  assert.equal(resolveStoreByTitle(STORES, ''), null);
});

test('the single-store upload now also refuses a legal-named report of another store', () => {
  assert.equal(storeTitleConflict(STORES, 'פינק מרקט י. ר. בע"מ', 3).id, 4, "Pink's report filed under מידנייט is caught");
  assert.equal(storeTitleConflict(STORES, 'פינק מרקט י. ר. בע"מ', 4), null, 'under its own store it passes');
});

let db, o, server, base;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('each file lands in its printed store; a file without a name, or a broken one, is refused alone', async () => {
  const jr = await db.one("SELECT id, name FROM stores WHERE name LIKE 'ג%'", []);
  const res = await importRevenueFiles([
    { name: 'תקופה.pdf', buffer: fx('revenue-junior-period.pdf') },
    { name: 'יומי.pdf', buffer: fx('revenue-junior.pdf') },
    { name: 'יומי.xls', buffer: fx('revenue-junior.xls') },
    { name: 'שבור.pdf', buffer: Buffer.from('%PDF-1.4 not really') },
  ], o, db);
  assert.deepEqual(res.map((r) => r.ok), [true, true, false, false]);
  assert.equal(res[0].storeId, jr.id);
  assert.match(res[0].text, /^ג'וניור: 01\/10\/2026–15\/10\/2026 · מכירות ₪/);
  assert.match(res[1].text, /^ג'וניור: 17\/10\/2026 · מכירות ₪/);
  assert.match(res[2].text, /אין בקובץ שם חנות/);
  assert.match(res[3].text, /^שבור\.pdf: /);
  const period = await db.one('SELECT store_id, date_from, date_to FROM revenue_periods', []);
  assert.deepEqual([Number(period.store_id), period.date_from, period.date_to], [jr.id, '2026-10-01', '2026-10-15']);
  assert.ok(await db.one("SELECT id FROM revenue_reports WHERE store_id = ? AND report_date = '2026-10-17'", [jr.id]));
});

test('route: owner-only, multipart, PRG back to settings with a per-file summary; the form sits in "סנכרון מהבנק"', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([fx('revenue-junior-period.pdf')], { type: 'application/pdf' }), 'p.pdf');
  fd.append('files', new Blob([fx('revenue-junior.xls')]), 'd.xls');
  const res = await fetch(`${base}/settings/revenue-bulk`, { method: 'POST', redirect: 'manual', body: fd, headers: { cookie: `session=${createSession(o.id)}` } });
  assert.equal(res.status, 303);
  const ok = new URLSearchParams(res.headers.get('location').split('?')[1]).get('ok');
  assert.match(ok, /^קליטה מרוכזת: 1 מתוך 2 נקלטו\. ✓ ג'וניור: 01\/10\/2026–15\/10\/2026 .* · ✗ d\.xls: אין בקובץ שם חנות/);

  const html = await (await fetch(`${base}/settings`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  const box = html.slice(html.indexOf('id="bank-sync-settings"'), html.indexOf('</details>', html.indexOf('id="bank-sync-settings"')));
  assert.match(box, /<form method="post" action="\/settings\/revenue-bulk" enctype="multipart\/form-data" class="rev-bulk" data-busy="קולט…">/);
  assert.match(box, /name="files" accept="\.pdf,application\/pdf" multiple required/);

  const sec = await db.one("SELECT * FROM users WHERE role='secretary' LIMIT 1", []);
  const denied = await fetch(`${base}/settings/revenue-bulk`, { method: 'POST', redirect: 'manual', body: new FormData(), headers: { cookie: `session=${createSession(sec.id)}` } });
  assert.equal(denied.status, 403, 'non-owner refused');
});
