import { getExecutor, nowTs } from '../db/adapter.js';

// In-app notification stream — the same alerts pushed to Telegram are recorded here so the owner
// isn't dependent on Telegram. A single global read marker (the bell is owner-facing). Every write
// is best-effort: on a live DB that predates the table ("עדכן מסד נתונים" not yet run) it no-ops
// rather than throwing into the request path.

/** Record a notification. Best-effort — swallows a missing-table / uninitialised-DB error. */
export async function recordNotification({ kind = 'alert', title, body = null, link = null, storeId = null }, x = getExecutor()) {
  const t = (title ?? '').toString().trim();
  if (!t) return null;
  const sid = storeId == null ? null : Number(storeId);
  try {
    const info = await x.run(
      'INSERT INTO notifications (kind, title, body, link, store_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [kind, t.slice(0, 200), body ? String(body).slice(0, 2000) : null, link, sid, nowTs()],
    );
    return info.lastInsertRowid;
  } catch {
    // מסד שעדיין לא עודכן אין בו store_id. ההתראה חשובה יותר מהשיוך, ולכן ניסיון שני בלי
    // העמודה — אחרת כל התראה נבלעת בשקט בין הדפלוי ללחיצה על "עדכן מסד נתונים".
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
}

/**
 * 🔴 probe: does `notifications.store_id` exist? (ראה CLAUDE.md — `catch` שמגן על מסד לפני עדכון
 * חייב להגיע עם probe שאומר זאת בקול.) בלעדיו סינון לפי חנות על מסד ישן היה זורק, ה-catch היה
 * מחזיר רשימה ריקה, והרובריקה הייתה אומרת "אין התראות" במקום "צריך לעדכן מסד נתונים".
 */
export async function notificationStoreReady(x = getExecutor()) {
  try {
    await x.many('SELECT store_id FROM notifications LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

/**
 * Most recent notifications, newest first.
 *
 * `storeId` מסנן להתראות של אותה חנות **בלבד** — התראה ללא שיוך (כלל-ארגונית, או ישנה מלפני
 * העמודה) אינה מוצגת תחת חנות ספציפית. זו ההחלטה הנכונה לשורת כסף: התראה על מזומן שמוצגת תחת
 * הסניף הלא-נכון נראית כמו חוב של הסניף הזה, ועדיף לא להציג מאשר להציג שקר. בתצוגת "כל החנויות"
 * (storeId ריק) הכול מוצג, ולכן שום התראה אינה נעלמת מהמערכת.
 */
export async function listNotifications({ limit = 50, storeId = null } = {}, x = getExecutor()) {
  try {
    if (storeId) {
      return await x.many(
        'SELECT * FROM notifications WHERE store_id = ? ORDER BY id DESC LIMIT ?',
        [Number(storeId), limit],
      );
    }
    return await x.many('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', [limit]);
  } catch {
    return [];
  }
}

/** כמה התראות מסוג מסוים עדיין ללא שיוך לחנות — כדי שהרובריקה תוכל לומר שהן קיימות ולא להשתיקן. */
export async function unscopedNotificationCount(kinds = [], x = getExecutor()) {
  if (!kinds.length) return 0;
  try {
    const marks = kinds.map(() => '?').join(', ');
    const r = await x.one(
      `SELECT COUNT(*) AS n FROM notifications WHERE store_id IS NULL AND kind IN (${marks})`,
      kinds,
    );
    return Number(r?.n || 0);
  } catch {
    return 0;
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
