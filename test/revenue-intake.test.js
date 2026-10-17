// בעלים, 17/10: "תבנה את הקליטה של דוח הפדיון" — מהקופה לג׳ימייל, ומשם בסקריפט אל האפליקציה.
// החנות נקבעת לפי שם הסניף שבנושא המייל, היום לפי חותמת הקופה, ושום דבר לא מנוחש.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { freshDb, owner, secretary, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { revenueIngestSecret, reportDateFrom, pickReportFile, resolveStoreByBranch, branchFromSubject } from '../src/lib/revenueIngest.js';
import { buildRevenueIngestScript } from '../src/lib/revenueIngestScript.js';
import { listNotifications } from '../src/services/notifications.js';

const realReport = () => readFileSync(fileURLToPath(new URL('./fixtures/revenue-midnight.xls', import.meta.url)));

test('the business day: explicit › POS stamp in the file name › send time › yesterday; before 06:00 = the day before', () => {
  assert.deepEqual(reportDateFrom({ date: '2026-10-01', fileName: 'פדיון-A4_20261016235900_1.xls' }), { date: '2026-10-01', from: 'date' });
  assert.deepEqual(reportDateFrom({ fileName: 'פדיון-A4_20261016235900_115.xls' }), { date: '2026-10-16', from: 'file' });
  assert.deepEqual(reportDateFrom({ fileName: 'פדיון-A4_20261017003000_9.xls' }), { date: '2026-10-16', from: 'file' }, '00:30 still reports the 16th');
  // 05/08 21:24 UTC = 06/08 00:24 Israel → the 5th (the real one-off mail that reached the owner).
  assert.deepEqual(reportDateFrom({ fileName: 'פדיון-A4.xls', sent: '2026-08-05T21:24:31Z' }), { date: '2026-08-05', from: 'sent' });
  assert.deepEqual(reportDateFrom({ sent: '2026-10-16T20:59:58Z' }), { date: '2026-10-16', from: 'sent' }, '23:59 Israel = that day');
  assert.deepEqual(reportDateFrom({ today: '2026-10-17' }), { date: '2026-10-16', from: 'default' });
});

test('the store comes from the POS branch name — one clear match or nothing', () => {
  const stores = [{ id: 1, name: 'מידנייט' }, { id: 2, name: 'סופר על הדרך' }, { id: 3, name: 'פינק מרקט' }, { id: 4, name: "ג'וניור" }];
  assert.deepEqual(branchFromSubject('[ דו"ח ] 3: יומי סניף: 3 מידנייט '), { no: '3', name: 'מידנייט' });
  // בעלים, 17/10: "סניף 1 זה ג'וניור" — the till never named it ("null").
  assert.deepEqual(branchFromSubject('[ דו"ח ] 1: יומי סניף: 1 null '), { no: '1', name: "ג'וניור" });
  assert.equal(resolveStoreByBranch(stores, branchFromSubject('[ דו"ח ] 1: יומי סניף: 1 null ').name).id, 4);
  assert.deepEqual(branchFromSubject('[ דו"ח ] 9: יומי סניף: 9 null '), { no: '9', name: 'null' }, 'no alias → stays unnamed');
  assert.equal(resolveStoreByBranch(stores, 'מידנייט').id, 1);
  assert.equal(resolveStoreByBranch(stores, 'סופר').id, 2, 'the POS shortens names');
  assert.equal(resolveStoreByBranch(stores, 'פינק מרקט').id, 3);
  assert.equal(resolveStoreByBranch(stores, 'null'), null, 'an unnamed POS branch is never guessed');
  assert.equal(resolveStoreByBranch([...stores, { id: 5, name: 'מידנייט 2' }], 'מידנייט').id, 1, 'an exact name wins');
  assert.equal(resolveStoreByBranch([{ id: 1, name: 'סופר א' }, { id: 2, name: 'סופר ב' }], 'סופר'), null, 'two candidates = refused');
});

test('the "פדיון" sheet is picked out of a mail with other attachments', () => {
  const f = (originalname) => ({ originalname, mimetype: 'application/octet-stream' });
  assert.equal(pickReportFile([f('גחנון.xls'), f('פדיון-A4_20261016235900_1.xls'), f('x.pdf')]).originalname, 'פדיון-A4_20261016235900_1.xls');
  assert.equal(pickReportFile([f('a.pdf')]), null);
});

test('the secret: env first, else derived from an explicit SESSION_SECRET, else none', () => {
  const saved = { env: config.revenueIngestSecret, has: config.auth.hasExplicitSecret, sess: config.auth.sessionSecret };
  try {
    config.revenueIngestSecret = 'from-env';
    assert.equal(revenueIngestSecret(), 'from-env');
    config.revenueIngestSecret = null;
    config.auth.hasExplicitSecret = false;
    assert.equal(revenueIngestSecret(), null, 'a random per-process session secret would change every cold start');
    config.auth.hasExplicitSecret = true;
    config.auth.sessionSecret = 'session-A';
    const a = revenueIngestSecret();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, 'session-A');
    config.auth.sessionSecret = 'session-B';
    assert.notEqual(revenueIngestSecret(), a);
  } finally {
    config.revenueIngestSecret = saved.env; config.auth.hasExplicitSecret = saved.has; config.auth.sessionSecret = saved.sess;
  }
});

test('the Gmail script carries the app address and the secret, and only takes "פדיון" sheets', () => {
  const src = buildRevenueIngestScript({ appUrl: 'https://ap-control.vercel.app/', secret: 'abc"\'def' });
  assert.match(src, /var APP_URL = "https:\/\/ap-control\.vercel\.app";/);
  assert.match(src, /var SECRET = "abc\\"'def";/, 'JSON-escaped — a quote cannot break the script');
  assert.match(src, /function installTrigger\(\)/);
  assert.match(src, /everyHours\(1\)/);
  assert.match(src, /if \(!\/פדיון\/\.test\(name\)/);
  assert.match(src, /'x-ingest-secret': SECRET/);
});

let db, ow, st, server, base;
const savedSecret = config.revenueIngestSecret;
before(async () => {
  db = await freshDb();
  ow = await owner(db);
  st = await firstStore(db);
  config.revenueIngestSecret = 's3cret';
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); config.revenueIngestSecret = savedSecret; });

const post = (qs, files, secret = 's3cret') => {
  const fd = new FormData();
  for (const [name, buf] of files) fd.append('file', new Blob([buf]), name);
  return fetch(`${base}/ingest/revenue-report?${qs}`, { method: 'POST', body: fd, headers: secret ? { 'x-ingest-secret': secret } : {} });
};

test('a POS mail as the script sends it: store from the subject, day from the stamp, the real .xls imported', async () => {
  const subject = `[ דו"ח ] 3: יומי סניף: 3 ${st.name} `;
  const name = 'פדיון-A4_20261016235900_115.xls';
  const r = await post(`subject=${encodeURIComponent(subject)}&sent=2026-10-16T20:59:58Z&file_name=${encodeURIComponent(name)}`,
    [['גחנון.xls', Buffer.from('not this one')], [name, realReport()]]);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.store, st.name);
  assert.equal(j.date, '2026-10-16');
  assert.equal(j.dateFrom, 'file');
  const row = await db.one('SELECT store_id, source, gross_sales FROM revenue_reports WHERE report_date = ?', ['2026-10-16']);
  assert.equal(Number(row.store_id), Number(st.id));
  assert.equal(row.source, 'email');
  assert.ok(Number(row.gross_sales) > 0);
});

test('a branch with no matching store is refused (422) and the owner is told — nothing imported', async () => {
  const before = await db.one('SELECT COUNT(*) AS n FROM revenue_reports', []);
  const r = await post(`subject=${encodeURIComponent('[ דו"ח ] 9: יומי סניף: 9 null ')}&file_name=x.xls`, [['פדיון-A4.xls', realReport()]]);
  assert.equal(r.status, 422);
  const after = await db.one('SELECT COUNT(*) AS n FROM revenue_reports', []);
  assert.equal(Number(after.n), Number(before.n));
  const notes = await listNotifications({ limit: 10 }, db);
  assert.ok(notes.some((n) => /דוח פדיון לא נקלט/.test(n.title) && n.link === '/reconciliation/revenue-intake'));
});

test('wrong / missing secret → 401, before anything is read', async () => {
  assert.equal((await post('store=1', [['פדיון.xls', realReport()]], 'nope')).status, 401);
  assert.equal((await post('store=1', [['פדיון.xls', realReport()]], null)).status, 401);
});

test('the intake page (owner only) hands over the ready script; the button sits left of "סנכרן עכשיו"', async () => {
  const own = `session=${createSession(ow.id)}; ap_store=${st.id}`;
  const page = await fetch(`${base}/reconciliation/revenue-intake`, { headers: { cookie: own } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  const html = await page.text();
  assert.match(html, /var SECRET = &#34;s3cret&#34;;/, 'the script with its secret, HTML-escaped in the textarea');
  assert.match(html, /installTrigger/);
  const sec = await secretary(db);
  const r = await fetch(`${base}/reconciliation/revenue-intake`, { headers: { cookie: `session=${createSession(sec.id)}; ap_store=${st.id}` }, redirect: 'manual' });
  assert.notEqual(r.status, 200, 'not for the secretary');
  const recon = await (await fetch(`${base}/reconciliation`, { headers: { cookie: own } })).text();
  const sync = recon.indexOf('🔄 סנכרן עכשיו</button>');
  const link = recon.indexOf('href="/reconciliation/revenue-intake"');
  assert.ok(sync > 0 && link > sync, 'right after the sync button in the DOM = to its left in RTL');
});

test('"סניף: 1 null" lands on ג\'וניור (owner, 17/10)', async () => {
  const jr = await db.one("SELECT id FROM stores WHERE name = ?", ["ג'וניור"]);
  assert.ok(jr, "the seed has a store named ג'וניור");
  const r = await post(`subject=${encodeURIComponent('[ דו"ח ] 1: יומי סניף: 1 null ')}&file_name=${encodeURIComponent('פדיון-A4_20261015235900_7.xls')}`,
    [['פדיון-A4_20261015235900_7.xls', realReport()]]);
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  assert.equal(j.store, "ג'וניור");
  assert.equal(j.date, '2026-10-15');
  assert.ok(await db.one('SELECT id FROM revenue_reports WHERE store_id = ? AND report_date = ?', [jr.id, '2026-10-15']));
});
