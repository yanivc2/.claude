import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, owner } from './helpers.js';
import { createEvent, listEventsInRange, deleteEvent, runDueReminders } from '../src/services/calendar.js';

test('create, list (by range) and delete calendar events', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  const id = await createEvent({ title: 'פגישה', eventDate: '2026-08-15', eventTime: '10:30', remind: true }, ow, db);
  await createEvent({ title: 'מחוץ לטווח', eventDate: '2026-09-20', remind: false }, ow, db);

  const inRange = await listEventsInRange('2026-08-01', '2026-08-31', db);
  assert.equal(inRange.length, 1);
  assert.equal(inRange[0].title, 'פגישה');
  assert.equal(inRange[0].event_time, '10:30');
  assert.equal(inRange[0].remind, 1);

  await deleteEvent(id, ow, db);
  assert.equal((await listEventsInRange('2026-08-01', '2026-08-31', db)).length, 0);
});

test('createEvent validates title and date', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await assert.rejects(createEvent({ title: '', eventDate: '2026-08-15' }, ow, db), /כותרת/);
  await assert.rejects(createEvent({ title: 'x', eventDate: 'bad' }, ow, db), /תאריך/);
});

test('runDueReminders picks only due, unsent reminders (no send when Telegram off)', async () => {
  const db = await freshDb();
  const ow = await owner(db);
  await createEvent({ title: 'עבר', eventDate: '2026-08-01', eventTime: '09:00', remind: true }, ow, db);
  await createEvent({ title: 'עתיד', eventDate: '2026-08-30', eventTime: '09:00', remind: true }, ow, db);
  await createEvent({ title: 'ללא תזכורת', eventDate: '2026-08-01', remind: false }, ow, db);

  const now = new Date('2026-08-10T12:00:00Z').getTime();
  const calls = [];
  const fakeSend = async (msg) => { calls.push(msg); return true; };
  const r = await runDueReminders(now, db, fakeSend);
  assert.equal(r.due, 1); // only the past reminder is due
  assert.equal(r.sent, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /עבר/);
  // second run finds nothing (already marked sent)
  assert.equal((await runDueReminders(now, db, fakeSend)).due, 0);
});
