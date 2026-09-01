import { getExecutor, nowTs } from '../db/adapter.js';

// In-app notification stream — the same alerts pushed to Telegram are recorded here so the owner
// isn't dependent on Telegram. A single global read marker (the bell is owner-facing). Every write
// is best-effort: on a live DB that predates the table ("עדכן מסד נתונים" not yet run) it no-ops
// rather than throwing into the request path.

/** Record a notification. Best-effort — swallows a missing-table / uninitialised-DB error. */
export async function recordNotification({ kind = 'alert', title, body = null, link = null }, x = getExecutor()) {
  const t = (title ?? '').toString().trim();
  if (!t) return null;
  try {
    const info = await x.run(
      'INSERT INTO notifications (kind, title, body, link, created_at) VALUES (?, ?, ?, ?, ?)',
      [kind, t.slice(0, 200), body ? String(body).slice(0, 2000) : null, link, nowTs()],
    );
    return info.lastInsertRowid;
  } catch {
    return null; // table not created yet, or DB not initialised — alerts are best-effort
  }
}

/** Most recent notifications, newest first. */
export async function listNotifications({ limit = 50 } = {}, x = getExecutor()) {
  try {
    return await x.many('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', [limit]);
  } catch {
    return [];
  }
}

/** Count of unread notifications (read_at IS NULL). Tolerant if the table doesn't exist yet. */
export async function unreadNotificationCount(x = getExecutor()) {
  try {
    const r = await x.one('SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL', []);
    return Number(r?.n || 0);
  } catch {
    return 0;
  }
}

/** Mark one notification read. */
export async function markNotificationRead(id, x = getExecutor()) {
  await x.run('UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL', [nowTs(), Number(id)]);
}

/** Mark every unread notification read. */
export async function markAllNotificationsRead(x = getExecutor()) {
  await x.run('UPDATE notifications SET read_at = ? WHERE read_at IS NULL', [nowTs()]);
}
