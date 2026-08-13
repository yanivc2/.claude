import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { loginAllowedNow, israelClock, parseHhmm } from '../src/lib/loginHours.js';
import { createUser, updateUser, getUser } from '../src/services/users.js';

test('parseHhmm accepts valid times, rejects junk', () => {
  assert.equal(parseHhmm('09:30'), 570);
  assert.equal(parseHhmm('00:00'), 0);
  assert.equal(parseHhmm('23:59'), 1439);
  assert.equal(parseHhmm('24:00'), null);
  assert.equal(parseHhmm(''), null);
  assert.equal(parseHhmm('9'), null);
});

test('owner and users without a full window are always allowed', () => {
  assert.equal(loginAllowedNow({ role: 'owner', login_start: '09:00', login_end: '17:00' }).allowed, true);
  assert.equal(loginAllowedNow({ role: 'secretary' }).allowed, true);
  assert.equal(loginAllowedNow({ role: 'secretary', login_start: '09:00' }).allowed, true); // half window
});

test('daytime window is enforced in Israel time (August = +3)', () => {
  const now = new Date('2026-08-13T09:00:00Z'); // 12:00 in Israel
  assert.equal(israelClock(now).hhmm, '12:00');
  assert.equal(loginAllowedNow({ role: 'secretary', login_start: '09:00', login_end: '17:00' }, now).allowed, true);
  const blocked = loginAllowedNow({ role: 'secretary', login_start: '18:00', login_end: '22:00' }, now);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.window, '18:00–22:00');
  assert.equal(blocked.hhmm, '12:00');
});

test('overnight window wraps midnight', () => {
  const now = new Date('2026-08-12T21:00:00Z'); // 00:00 in Israel
  assert.equal(israelClock(now).hhmm, '00:00');
  assert.equal(loginAllowedNow({ role: 'secretary', login_start: '23:00', login_end: '01:00' }, now).allowed, true);
  assert.equal(loginAllowedNow({ role: 'secretary', login_start: '02:00', login_end: '05:00' }, now).allowed, false);
});

test('login hours persist on create + update (empty clears)', async () => {
  const x = await freshDb();
  const o = await owner(x);
  const u = await createUser(
    { name: 'מזכירה', username: 'sec9', role: 'secretary', password: 'Initial123', loginStart: '9:00', loginEnd: '17:30' },
    o, x,
  );
  assert.equal(u.login_start, '09:00'); // normalized
  assert.equal(u.login_end, '17:30');

  await updateUser(u.id, { name: 'מזכירה', loginStart: '', loginEnd: '' }, o, x);
  const after = await getUser(u.id, x);
  assert.equal(after.login_start, null);
  assert.equal(after.login_end, null);
});
