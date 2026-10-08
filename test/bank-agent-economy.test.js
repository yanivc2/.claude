// 🌙 מצב חיסכון של סוכן הבנק: מחוץ לשעות הפעילות הוא שואל רק פעם ב-N דקות (ברירת מחדל 30) —
// מספיק כדי לסנכרן בערב ובסוף שבוע, בלי לשאול את Vercel כל 30 שניות. בצד השרת: חלון התפיסה
// מתארך ל-N דקות, והכרטיס אומר "מצב חיסכון" ולא "לא מחובר".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { agentSchedule, offEveryMin, AFTER_JOB_AWAKE_MS } from '../agent/bank-agent.mjs';
import { requestSync, syncStatus, claimNext, claimWindowSec, CLAIM_WINDOW_SEC } from '../src/services/bankSyncJobs.js';

const MIN = 60_000;
const ago = (sec) => new Date(Date.now() - sec * 1000).toISOString().slice(0, 19).replace('T', ' ');

test('offEveryMin: default 30 (owner\'s choice), 0 = off, clamped to 2..120', () => {
  assert.equal(offEveryMin({}), 30);
  assert.equal(offEveryMin({ offHoursCheckMinutes: 0 }), 0);
  assert.equal(offEveryMin({ offHoursCheckMinutes: 1 }), 2);
  assert.equal(offEveryMin({ offHoursCheckMinutes: 500 }), 120);
  assert.equal(offEveryMin({ offHoursCheckMinutes: 15 }), 15);
});

test('schedule: in hours every 30s; off hours one request per N minutes; awake for a while after a job', () => {
  const now = 1_000_000_000;
  assert.deepEqual(agentSchedule({ inHours: true, now, pollEveryMs: 30_000 }), { action: 'poll', mode: 'on', waitMs: 30_000 });
  // off hours, economy off → no request at all (the previous behaviour)
  assert.equal(agentSchedule({ inHours: false, now, offEvery: 0 }).action, 'wait');
  // off hours, due → one request, next one in N minutes
  assert.deepEqual(agentSchedule({ inHours: false, now, offEvery: 10, nextOffCheck: now }), { action: 'poll', mode: 'off', waitMs: 10 * MIN });
  // off hours, not due → wait locally (≤ 1 minute at a time, so a config change is picked up)
  const w = agentSchedule({ inHours: false, now, offEvery: 10, nextOffCheck: now + 7 * MIN });
  assert.equal(w.action, 'wait');
  assert.equal(w.waitMs, MIN);
  // right after a job at night: fast polling for a while (a retry after a missed SMS is picked up at once)
  assert.equal(agentSchedule({ inHours: false, now, offEvery: 10, awakeUntil: now + AFTER_JOB_AWAKE_MS, nextOffCheck: now + 9 * MIN }).mode, 'on');
  // count with the default: one night hour = 2 requests, not 120
  let polls = 0; let next = 0;
  for (let t = now; t < now + 60 * MIN; t += 30_000) {
    const p = agentSchedule({ inHours: false, now: t, offEvery: offEveryMin({}), nextOffCheck: next });
    if (p.action === 'poll') { polls += 1; next = t + p.waitMs; }
  }
  assert.equal(polls, 2);
});

test('server: economy heartbeat → card says economy, a request waits N minutes instead of 2', async () => {
  const x = await freshDb();
  const o = await owner(x);
  assert.equal(await claimNext('office-pc', x, { hours: 'א׳–ה׳ 08:00-16:00', mode: 'off', offEvery: 10 }), null);
  const st = await syncStatus(o, null, x);
  assert.equal(st.agentEconomy, true);
  assert.equal(st.agentOnline, false, 'not "connected" — it only asks every 10 minutes');
  assert.equal(st.agentOffEvery, 10);
  assert.equal(claimWindowSec({ mode: 'off', offEvery: 10 }), 10 * 60 + 90);
  assert.equal(claimWindowSec({ mode: 'on', offEvery: 10 }), CLAIM_WINDOW_SEC);

  const job = await requestSync(o, x);
  assert.match(job.message, /מצב חיסכון, הבקשה תיאסף תוך עד 10 דקות/);
  // 5 minutes later it is still waiting (in normal mode it would have expired after 2)
  await x.run('UPDATE bank_sync_jobs SET requested_at = ?, updated_at = ? WHERE id = ?', [ago(5 * 60), ago(5 * 60), job.id]);
  const claimed = await claimNext('office-pc', x, { mode: 'off', offEvery: 10 });
  assert.equal(claimed.id, job.id, 'picked up by the next economy check');
});

test('server: still bounded — a request older than N minutes + slack expires (no SMS to an empty office)', async () => {
  const x = await freshDb();
  const o = await owner(x);
  await claimNext('office-pc', x, { mode: 'off', offEvery: 10 });
  const job = await requestSync(o, x);
  await x.run('UPDATE bank_sync_jobs SET requested_at = ?, updated_at = ? WHERE id = ?', [ago(12 * 60), ago(12 * 60), job.id]);
  assert.equal(await claimNext('office-pc', x, { mode: 'off', offEvery: 10 }), null);
  const row = await x.one('SELECT status, message FROM bank_sync_jobs WHERE id = ?', [job.id]);
  assert.equal(row.status, 'expired');
  assert.match(row.message, /לא הגיב תוך 12 דקות/);
});

test('the status card renders the economy state', async () => {
  const ejs = (await import('ejs')).default;
  const fs = await import('node:fs');
  const tpl = fs.readFileSync('src/views/reconciliation/_bankSync.ejs', 'utf8');
  const html = ejs.render(tpl, { bankSync: { ready: true, agentOnline: false, agentEconomy: true, agentOffEvery: 10, agentHours: 'א׳–ה׳ 08:00-16:00', agentSeenSec: 120, job: null, loginKey: 'x' }, formatDate: (d) => d, can: () => true }, { filename: 'src/views/reconciliation/_bankSync.ejs' });
  assert.match(html, /מחשב המשרד במצב חיסכון/);
  assert.match(html, /תיאסף תוך עד 10 דקות/);
});
