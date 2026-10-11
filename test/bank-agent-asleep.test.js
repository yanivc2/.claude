// בעלים (12/10, 02:27): "סנכרן עכשיו" בלילה נכשל אחרי 2 דקות ב"מחשב המשרד לא הגיב". הסוכן הישן
// לא בודק בקשות מחוץ לשעות — את זה יודעים מראש מהתווית שהוא עצמו שולח, ולכן אומרים זאת מיד.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ejs from 'ejs';
import { freshDb, owner } from './helpers.js';
import { setSetting } from '../src/services/appSettings.js';
import { outsideAgentHours, agentAsleep, requestSync, syncStatus } from '../src/services/bankSyncJobs.js';

const L = 'א׳–ה׳ 08:00-16:00';
const il = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h - 3, mi)); // שעון קיץ ישראל = UTC+3
const old = (secAgo) => new Date(Date.now() - secAgo * 1000).toISOString().slice(0, 19).replace('T', ' ');

test('the agent\'s own hours label tells inside from outside (Israel time)', () => {
  assert.equal(outsideAgentHours(L, il(2026, 10, 12, 2, 27)), true, 'Mon 02:27 — before 08:00');
  assert.equal(outsideAgentHours(L, il(2026, 10, 11, 10, 0)), false, 'Sun 10:00 — inside');
  assert.equal(outsideAgentHours(L, il(2026, 10, 11, 16, 0)), true, 'Sun 16:00 — the end is exclusive');
  assert.equal(outsideAgentHours(L, il(2026, 10, 16, 10, 0)), true, 'Fri — not an active day');
  assert.equal(outsideAgentHours('א׳,ג׳', il(2026, 10, 13, 3, 0)), false, 'Tue, days only — inside all day');
  assert.equal(outsideAgentHours('22:00-06:00', il(2026, 10, 12, 2, 0)), false, 'a range across midnight');
  assert.equal(outsideAgentHours('בלה'), null, 'unparsable → unknown, never a guess');
  assert.equal(outsideAgentHours(null), null);
});

test('asleep = old heartbeat + outside hours + no economy mode; legacy = no mode at all', () => {
  const night = il(2026, 10, 12, 2, 27);
  assert.deepEqual(agentAsleep({ at: old(3600), hours: L }, night), { hours: L, legacy: true });
  assert.deepEqual(agentAsleep({ at: old(3600), hours: L, mode: 'sleep', offEvery: 0 }, night), { hours: L, legacy: false });
  assert.equal(agentAsleep({ at: old(600), hours: L, mode: 'off', offEvery: 30 }, night), null, 'economy mode collects it');
  assert.equal(agentAsleep({ at: old(10), hours: L }, night), null, 'it just pinged — trust it');
  assert.equal(agentAsleep({ at: old(3600), hours: L }, il(2026, 10, 12, 10, 0)), null, 'inside hours: a PC that is off is another story');
  assert.equal(agentAsleep(null, night), null);
});

test('a request while the old agent sleeps is refused at once, with the reason — nothing is queued', async () => {
  const x = await freshDb();
  const own = await owner(x);
  // תווית שכל יום ושעה שהבדיקה רצה בהם הם מחוצה לה: יום אחד, דקה אחת.
  const { day } = (() => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jerusalem', weekday: 'short' }).format(new Date());
    return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p) };
  })();
  const other = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'][(day + 3) % 7];
  await setSetting('bank_agent_heartbeat', JSON.stringify({ at: old(5 * 3600), agent: 'office-pc', hours: `${other}׳ 08:00-16:00` }), x);
  await assert.rejects(() => requestSync(own, x), /מחוץ לשעות הפעילות של הסוכן[\s\S]*הגרסה הישנה/);
  assert.equal(Number((await x.one('SELECT COUNT(*) AS n FROM bank_sync_jobs', [])).n), 0);
  const st = await syncStatus(own, null, x);
  assert.match(st.agentAsleepMsg || '', /bank-agent\.mjs/);
});

test('the card says why and the button is disabled while asleep', () => {
  const tpl = fs.readFileSync('src/views/reconciliation/_bankSync.ejs', 'utf8');
  const html = ejs.render(tpl, {
    bankSync: { ready: true, agentOnline: false, agentEconomy: false, agentHours: L, agentSeenSec: 36000,
      agentAsleepMsg: 'עכשיו מחוץ לשעות הפעילות של הסוכן (א׳–ה׳ 08:00-16:00, שעון ישראל)', job: null, loginKey: 'x' },
    formatDate: (d) => d, can: () => true,
  }, { filename: 'src/views/reconciliation/_bankSync.ejs' });
  assert.match(html, /עכשיו מחוץ לשעות הפעילות של הסוכן/);
  assert.match(html, /<button type="submit" disabled[^>]*>🔄 סנכרן עכשיו/);
});
