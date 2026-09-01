// In-app notification stream: notify() records a notification, and the read helpers work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { notify } from '../src/lib/notify.js';
import {
  recordNotification,
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../src/services/notifications.js';

test('recordNotification stores and lists newest-first; read helpers clear the unread count', async () => {
  const db = await freshDb();
  await recordNotification({ kind: 'alert', title: 'ראשונה', body: 'גוף' }, db);
  const id2 = await recordNotification({ kind: 'alert', title: 'שנייה' }, db);

  const rows = await listNotifications({ limit: 10 }, db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'שנייה'); // newest first
  assert.equal(await unreadNotificationCount(db), 2);

  await markNotificationRead(id2, db);
  assert.equal(await unreadNotificationCount(db), 1);
  await markAllNotificationsRead(db);
  assert.equal(await unreadNotificationCount(db), 0);
});

test('notify() records an in-app notification (title = first line, body = rest)', async () => {
  const db = await freshDb();
  notify('⚠️ <b>צ׳ק מבוטל הופיע בדף הבנק</b>\nצ׳ק 6004 · 100 ₪');
  // notify() persists on a fire-and-forget microtask — let it settle.
  await new Promise((r) => setTimeout(r, 30));
  const rows = await listNotifications({ limit: 5 }, db);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /צ׳ק מבוטל הופיע בדף הבנק/);
  assert.match(rows[0].body, /6004/);
  assert.ok(!rows[0].title.includes('<b>')); // HTML stripped
});
