// בעלים 20/10: "תזכורת יומית לסנכרון בנק בשעה קבועה" — 12:00 שעון ישראל, א׳–ה׳, רק אם עוד לא סונכרן היום.
// Vercel מתזמן ב-UTC וישראל עוברת בין +2 ל-+3, ולכן שתי ריצות (09:00, 10:00 UTC) והשליחה רק כשבישראל 12.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDb } from './helpers.js';
import { bankSyncReminder } from '../src/services/bankSyncJobs.js';
import { israelWeekday, israelDayOf } from '../src/lib/loginHours.js';

// 2026-10-20 = Tuesday, Israel on summer time (+3) until 25/10; 2026-11-03 = Tuesday, winter (+2).
const SUMMER_12 = new Date('2026-10-20T09:15:00Z'); // 12:15 in Israel
const SUMMER_13 = new Date('2026-10-20T10:15:00Z'); // 13:15
const WINTER_11 = new Date('2026-11-03T09:15:00Z'); // 11:15
const WINTER_12 = new Date('2026-11-03T10:15:00Z'); // 12:15
const FRIDAY_12 = new Date('2026-10-23T09:15:00Z'); // Friday 12:15

const count = async (db) => (await db.one("SELECT COUNT(*) AS n FROM notifications WHERE title LIKE '%תזכורת: סנכרון בנק%'", [])).n;

test('Israel calendar helpers', () => {
  assert.equal(israelWeekday(SUMMER_12), 2);
  assert.equal(israelWeekday(FRIDAY_12), 5);
  assert.equal(israelDayOf('2026-10-19 22:30:00'), '2026-10-20', '01:30 in Israel is already the next day');
  assert.equal(israelDayOf(''), '');
});

test('sends exactly on the run where Israel reads 12:xx — in summer and in winter — and once a day', async () => {
  const db = await freshDb();
  assert.deepEqual(await bankSyncReminder({ now: SUMMER_13 }, db), { sent: false, reason: 'not 12:00 in Israel' });
  assert.deepEqual(await bankSyncReminder({ now: SUMMER_12 }, db), { sent: true });
  assert.equal(Number(await count(db)), 1, 'reaches the bell (and Telegram, when configured)');
  assert.deepEqual(await bankSyncReminder({ now: SUMMER_12 }, db), { sent: false, reason: 'already reminded today' });
  assert.equal((await bankSyncReminder({ now: WINTER_11 }, db)).sent, false);
  assert.equal((await bankSyncReminder({ now: WINTER_12 }, db)).sent, true, 'after the clock change the 10:00 UTC run is the one');
  assert.deepEqual(await bankSyncReminder({ now: FRIDAY_12 }, db), { sent: false, reason: 'not Sun–Thu in Israel' });
});

test('no reminder when a sync finished today or is running; a failed one still reminds', async () => {
  const db = await freshDb();
  const job = (status, at) => db.run(
    "INSERT INTO bank_sync_jobs (status, login_key, requested_at, updated_at, finished_at) VALUES (?, 'k', ?, ?, ?)", [status, at, at, at]);
  await job('failed', '2026-10-20 06:00:00');
  assert.equal((await bankSyncReminder({ now: SUMMER_12 }, db)).sent, true, 'a failed sync is not a sync');

  const db2 = await freshDb();
  await db2.run("INSERT INTO bank_sync_jobs (status, login_key, requested_at, updated_at, finished_at) VALUES ('done', 'k', '2026-10-20 05:10:00', '2026-10-20 05:12:00', '2026-10-20 05:12:00')", []);
  assert.deepEqual(await bankSyncReminder({ now: SUMMER_12 }, db2), { sent: false, reason: 'synced today' });

  const db3 = await freshDb();
  await db3.run("INSERT INTO bank_sync_jobs (status, login_key, requested_at, updated_at) VALUES ('awaiting_otp', 'k', '2026-10-20 09:05:00', '2026-10-20 09:05:00')", []);
  assert.deepEqual(await bankSyncReminder({ now: SUMMER_12 }, db3), { sent: false, reason: 'synced today' });

  const db4 = await freshDb();
  await db4.run("INSERT INTO bank_sync_jobs (status, login_key, requested_at, updated_at, finished_at) VALUES ('done', 'k', '2026-10-19 12:00:00', '2026-10-19 12:00:00', '2026-10-19 12:00:00')", []);
  assert.equal((await bankSyncReminder({ now: SUMMER_12 }, db4)).sent, true, "yesterday's sync does not count");
});

test('wired: two daily UTC runs in vercel.json, a CRON_SECRET-guarded route', () => {
  const v = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const runs = v.crons.filter((c) => c.path === '/ingest/bank-sync-reminder').map((c) => c.schedule).sort();
  assert.deepEqual(runs, ['0 10 * * 0-4', '0 9 * * 0-4']);
  const route = readFileSync(new URL('../src/routes/ingest.js', import.meta.url), 'utf8');
  const at = route.indexOf("router.all('/bank-sync-reminder'");
  assert.ok(at > 0);
  assert.match(route.slice(at, at + 600), /if \(!config\.cronSecret\) return res\.status\(503\)[\s\S]*if \(given !== config\.cronSecret\) return res\.status\(401\)/);
});
