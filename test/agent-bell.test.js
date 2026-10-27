// 🔔 פעמון לסוכן (בעלים 27/10: "כפתור רק אצלי שאוכל להעיר את הסוכן"). מחוץ לשעות הסוכן שואל רק
// פעם בחצי שעה; "סנכרן עכשיו" של הבעלים מצלצל לו דרך ntfy, והוא שואל מיד. בצלצול עובר רק "wake".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary } from './helpers.js';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { setSetting, getSetting } from '../src/services/appSettings.js';
import { bellTopic, ringAgentBell, parseBellStream, _setBellTransport, BELL_SERVER } from '../src/lib/agentBell.js';
import { requestSync, syncStatus, claimNext, bellOnly, agentAsleep, claimWindowSec } from '../src/services/bankSyncJobs.js';
import { makeBell, agentSchedule } from '../agent/bank-agent.mjs';

const old = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString().slice(0, 19).replace('T', ' ');

test('the topic is derived from the agent secret: same on both sides, never the secret itself', () => {
  const t = bellTopic('agent-s3cret');
  assert.match(t, /^apc-[0-9a-f]{32}$/);
  assert.equal(bellTopic('agent-s3cret'), t, 'deterministic — the agent computes it alone, nothing to configure');
  assert.notEqual(bellTopic('another'), t);
  assert.ok(!t.includes('agent-s3cret'));
  assert.equal(bellTopic(''), null);
  assert.equal(bellTopic(null), null);
});

test('ring: POST "wake" to the private topic, not cached; never throws', async () => {
  const calls = [];
  _setBellTransport(async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; });
  try {
    assert.deepEqual(await ringAgentBell({ secret: 'agent-s3cret' }), { ok: true });
    assert.equal(calls[0].url, `${BELL_SERVER}/${bellTopic('agent-s3cret')}`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.body, 'wake', 'only the word — no data, no secret');
    assert.equal(calls[0].init.headers.Cache, 'no', 'ntfy keeps nothing');

    assert.deepEqual(await ringAgentBell({ secret: null }), { ok: false, reason: 'no-secret' });
    assert.equal(calls.length, 1, 'no secret → no call');

    _setBellTransport(async () => ({ ok: false, status: 503 }));
    assert.deepEqual(await ringAgentBell({ secret: 'agent-s3cret' }), { ok: false, reason: 'http-503' });
    _setBellTransport(async () => { throw new TypeError('fetch failed'); });
    assert.deepEqual(await ringAgentBell({ secret: 'agent-s3cret' }), { ok: false, reason: 'network' });
  } finally {
    _setBellTransport(null);
  }
});

test('stream parsing: only "message" events ring; a half line waits for the next chunk', () => {
  const open = '{"id":"a","event":"open","topic":"t"}\n';
  const keep = '{"id":"b","event":"keepalive","topic":"t"}\n';
  const msg = '{"id":"c","event":"message","topic":"t","message":"wake"}\n';
  assert.deepEqual(parseBellStream(open + keep), { rings: 0, rest: '' });
  assert.deepEqual(parseBellStream(open + msg + msg), { rings: 2, rest: '' });
  const cut = parseBellStream(open + msg.slice(0, 20));
  assert.equal(cut.rings, 0);
  assert.equal(parseBellStream(cut.rest + msg.slice(20)).rings, 1, 'the rest joins the next chunk');
  assert.equal(parseBellStream('not json\n' + msg).rings, 1, 'a broken line is skipped');
});

test('agent: a ring cuts the sleep short; a ring while busy is kept for the next sleep', async () => {
  const bell = makeBell();
  const t0 = Date.now();
  const p = bell.sleep(60_000);
  setTimeout(() => bell.ring(), 20);
  assert.equal(await p, true);
  assert.ok(Date.now() - t0 < 5_000, 'woke at once, not after a minute');
  assert.equal(await bell.sleep(30), false, 'no ring → the time just passes');
  bell.ring(); // באמצע סנכרון — אף אחד לא ישן
  assert.equal(await bell.sleep(60_000), true, 'kept, so the next sleep returns at once');
});

test('agent: "the line is up" nudges a sleeper but never leaves a ring behind (no phantom "🔔 צלצול")', async () => {
  const bell = makeBell();
  const p = bell.sleep(60_000);
  setTimeout(() => bell.nudge(), 20);
  assert.equal(await p, true, 'a sleeping loop wakes to report at once');
  bell.nudge(); // באמצע שאלה — אף אחד לא ישן
  assert.equal(await bell.sleep(30), false, 'nothing kept: the next sleep is a real sleep');
});

test('claim reports whether the agent listens; an old agent (no field) = not listening', async () => {
  const x = await freshDb();
  await claimNext('office-pc', x, { hours: 'א׳–ה׳ 08:00-16:00', mode: 'off', offEvery: 30, bell: true });
  assert.equal(JSON.parse(await getSetting('bank_agent_heartbeat', null, x)).bell, true);
  await claimNext('office-pc', x, { hours: 'א׳–ה׳ 08:00-16:00', mode: 'off', offEvery: 30 });
  assert.equal(JSON.parse(await getSetting('bank_agent_heartbeat', null, x)).bell, null);
});

test('owner + listening agent: the job is saved first, then the bell rings; the card says it wakes at once', async () => {
  const x = await freshDb();
  const own = await owner(x);
  await setSetting('bank_agent_heartbeat', JSON.stringify({ at: old(60), agent: 'office-pc', hours: 'א׳–ה׳ 08:00-16:00', mode: 'off', offEvery: 30, bell: true }), x);
  let seen = null;
  const job = await requestSync(own, x, {
    ring: async () => {
      seen = Number((await x.one(`SELECT COUNT(*) AS n FROM bank_sync_jobs WHERE status = 'requested'`, [])).n);
      return { ok: true };
    },
  });
  assert.equal(seen, 1, 'rang only after the request existed — the woken agent finds it');
  assert.match(job.message, /מעיר את מחשב המשרד/);
  const st = await syncStatus(own, null, x);
  assert.equal(st.agentBell, true);
  assert.equal(st.agentBellOnly, false, 'economy mode + bell is not bell-only');
  const audit = await x.one(`SELECT details FROM audit_log WHERE action = 'bank_sync.request'`, []);
  assert.match(audit.details, /rang/);
});

test('a failed ring changes nothing but the wording — the request waits for the regular check', async () => {
  const x = await freshDb();
  const own = await owner(x);
  await setSetting('bank_agent_heartbeat', JSON.stringify({ at: old(60), agent: 'office-pc', hours: 'א׳–ה׳ 08:00-16:00', mode: 'off', offEvery: 30, bell: true }), x);
  const job = await requestSync(own, x, { ring: async () => ({ ok: false, reason: 'timeout' }) });
  const row = await x.one('SELECT status, message FROM bank_sync_jobs WHERE id = ?', [job.id]);
  assert.equal(row.status, 'requested');
  assert.match(row.message, /תוך עד 30 דקות/);
});

test('everyone rings now: a secretary sees the bell too, and an agent that listens is never "asleep"', async () => {
  const x = await freshDb();
  const sec = await secretary(x);
  // סוכן בלי בדיקה מחוץ לשעות (offHoursCheckMinutes: 0), בשעה שמחוץ לשעות שלו — אבל מאזין לפעמון.
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    .indexOf(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(new Date()));
  const other = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'][(day + 3) % 7];
  await setSetting('bank_agent_heartbeat', JSON.stringify({ at: old(5 * 3600), agent: 'office-pc', hours: `${other}׳ 08:00-16:00`, mode: 'sleep', offEvery: 0, bell: true }), x);
  const st = await syncStatus(sec, null, x);
  assert.equal(st.agentBell, true);
  assert.equal(st.agentAsleepMsg, null, 'the button is not locked');
  const job = await requestSync(sec, x, { ring: async () => ({ ok: true }) });
  assert.equal(job.status, 'requested');
  assert.match(job.message, /מעיר את מחשב המשרד/);
});

// 🔔 "רק פעמון" (בעלים 27/10: "תעבור מעכשיו"): הסוכן לא שואל בעצמו. בקשה שלא נאספה תוך 2 דקות = תקלה,
// נכשלת מיד בהודעה שאומרת מה לבדוק, ומתריעה פעם אחת.
test('bell-only: reported as its own mode, never "asleep"; an uncollected request fails in 2 minutes with one alert', async () => {
  const x = await freshDb();
  const own = await owner(x);
  await claimNext('office-pc', x, { hours: 'א׳–ה׳ 08:00-16:00', mode: 'bell', offEvery: 30, bell: true });
  const hb = JSON.parse(await getSetting('bank_agent_heartbeat', null, x));
  assert.equal(hb.mode, 'bell');
  assert.equal(bellOnly(hb), true);
  assert.equal(agentAsleep({ ...hb, at: old(5 * 3600) }), null);
  assert.equal(claimWindowSec(hb), 120, 'no 30-minute economy window — it should be up in seconds');

  const st = await syncStatus(own, null, x);
  assert.equal(st.agentBellOnly, true);
  assert.equal(st.agentEconomy, false);

  await x.run(
    `INSERT INTO bank_sync_jobs (status, login_key, requested_by, requested_at, updated_at, message) VALUES ('requested', 'owner', ?, ?, ?, 'x')`,
    [own.id, old(200), old(200)],
  );
  await syncStatus(own, null, x); // כל פנייה מריצה את בדיקת הפקיעה
  await syncStatus(own, null, x);
  const job = await x.one('SELECT status, message FROM bank_sync_jobs ORDER BY id DESC LIMIT 1', []);
  assert.equal(job.status, 'expired');
  assert.match(job.message, /לא התעורר[\s\S]*חלון הסוכן[\s\S]*Claude/);
  const alerts = await x.many(`SELECT title FROM notifications WHERE title LIKE ?`, ['%מחשב המשרד לא הגיב%']);
  assert.equal(alerts.length, 1, 'one alert, not one per page refresh');
});

test('agent schedule, bell-only: no questions at all — not even in working hours — unless rung or just synced', () => {
  const now = 1_000_000_000;
  assert.deepEqual(agentSchedule({ inHours: true, now, bellOnly: true }), { action: 'wait', mode: 'bell', waitMs: 60_000 });
  assert.deepEqual(agentSchedule({ inHours: false, now, offEvery: 30, bellOnly: true }), { action: 'wait', mode: 'bell', waitMs: 60_000 });
  assert.equal(agentSchedule({ inHours: true, now, bellOnly: true, awakeUntil: now + 1000 }).action, 'poll', 'after a ring');
  assert.equal(agentSchedule({ inHours: true, now, bellOnly: false }).action, 'poll', 'the bell line is down → the regular schedule');
});

let server, base;
before(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('route: every "סנכרן עכשיו" rings — the secretary\'s too', async () => {
  const saved = config.bankAgentSecret;
  config.bankAgentSecret = 'agent-s3cret';
  const calls = [];
  _setBellTransport(async (url) => { calls.push(url); return { ok: true, status: 200 }; });
  try {
    const x = await freshDb();
    const own = await owner(x);
    const sec = await secretary(x);
    await x.run(`UPDATE users SET permissions = ? WHERE id = ?`, [JSON.stringify(['nav_reconciliation', 'import_bank']), sec.id]);
    const post = (id) => fetch(`${base}/reconciliation/bank-sync/request`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie: `session=${createSession(id)}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: '',
    });
    const r1 = await post(sec.id);
    assert.equal(r1.status, 200, await r1.clone().text());
    assert.deepEqual(calls, [`${BELL_SERVER}/${bellTopic('agent-s3cret')}`], 'a secretary rings too');
    await x.run(`UPDATE bank_sync_jobs SET status = 'cancelled'`, []);
    const r2 = await post(own.id);
    assert.equal(r2.status, 200);
    assert.equal(calls.length, 2);
  } finally {
    config.bankAgentSecret = saved;
    _setBellTransport(null);
  }
});
