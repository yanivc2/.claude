import { getExecutor } from '../db/adapter.js';
import { RuleError, NotFoundError } from '../lib/errors.js';
import { sendTelegram } from '../lib/notify.js';
import { logAction } from './audit.js';

// Calendar events / reminders shown on the "יומן" page. A reminder (remind=1) with a date/time
// is pushed once via the Telegram bot (already the app's push channel) when it comes due — the
// reminders runner is triggered by a cron ping or the manual button.

export async function createEvent({ title, eventDate, eventTime, remind }, actor, x = getExecutor()) {
  const t = (title || '').trim();
  if (!t) throw new RuleError('VALIDATION', 'כותרת האירוע חובה');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate || '')) throw new RuleError('VALIDATION', 'תאריך אירוע חובה');
  const time = eventTime && /^\d{2}:\d{2}$/.test(eventTime) ? eventTime : null;
  const info = await x.run(
    'INSERT INTO calendar_events (title, event_date, event_time, remind, created_by) VALUES (?, ?, ?, ?, ?)',
    [t, eventDate, time, remind ? 1 : 0, actor?.id ?? null],
  );
  await logAction({ userId: actor?.id ?? null, action: 'event.create', entityType: 'calendar_event', entityId: info.lastInsertRowid, details: { eventDate, remind: !!remind } }, x);
  return info.lastInsertRowid;
}

export async function listEventsInRange(fromIso, toIso, x = getExecutor()) {
  return x.many(
    'SELECT * FROM calendar_events WHERE event_date BETWEEN ? AND ? ORDER BY event_date, event_time',
    [fromIso, toIso],
  );
}

export async function deleteEvent(id, actor, x = getExecutor()) {
  const row = await x.one('SELECT id FROM calendar_events WHERE id = ?', [id]);
  if (!row) throw new NotFoundError(`אירוע ${id} לא נמצא`);
  await x.run('DELETE FROM calendar_events WHERE id = ?', [id]);
  await logAction({ userId: actor?.id ?? null, action: 'event.delete', entityType: 'calendar_event', entityId: id }, x);
}

/**
 * Send any reminders that have come due (remind=1, not yet sent, datetime <= now) via Telegram,
 * marking each sent. `nowMs` is injectable for tests.
 * @returns {Promise<{sent:number, due:number}>}
 */
export async function runDueReminders(nowMs = Date.now(), x = getExecutor(), send = sendTelegram) {
  const pending = await x.many('SELECT * FROM calendar_events WHERE remind = 1 AND remind_sent = 0', []);
  const due = pending.filter((e) => {
    const iso = `${e.event_date}T${e.event_time || '00:00'}:00`;
    return new Date(iso).getTime() <= nowMs;
  });
  let sent = 0;
  for (const e of due) {
    const when = `${e.event_date}${e.event_time ? ' ' + e.event_time : ''}`;
    const ok = await send(`🔔 <b>תזכורת</b>\n${e.title}\n${when}`);
    if (ok) {
      await x.run('UPDATE calendar_events SET remind_sent = 1 WHERE id = ?', [e.id]);
      sent += 1;
    }
  }
  return { sent, due: due.length };
}
