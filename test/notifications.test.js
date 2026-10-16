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

// 🔴 נמדד במסך: הבעלים עמד ב"סופר על הדרך" ורובריקת "התראות מזומן" הציגה שתי התאמות שכר של
// עובדות מסניף אחר. בניגוד לשתי התקלות הקודמות מאותו סוג, כאן לא היה שירות ששכח לקרוא לסקופ —
// לטבלת notifications פשוט לא הייתה עמודת חנות בכלל, ולכן כל התראה הייתה גלובלית מעצם הגדרתה.
test('a cash alert belongs to its store, and an untagged one is never hung on a store', async () => {
  const db = await freshDb();
  const a = await db.one('SELECT * FROM stores ORDER BY id LIMIT 1', []);
  const b = await db.one('SELECT * FROM stores WHERE id <> ? ORDER BY id LIMIT 1', [a.id]);
  assert.ok(b, 'the seed must have a second store for this test to mean anything');

  await recordNotification({ kind: 'cash_match', title: 'התאמה בסניף א', storeId: a.id }, db);
  await recordNotification({ kind: 'cash_match', title: 'התאמה בסניף ב', storeId: b.id }, db);
  // התראה ישנה, מלפני העמודה — או התראה כלל-ארגונית (בנק/ספקים).
  await recordNotification({ kind: 'cash_match', title: 'ללא שיוך' }, db);

  const inB = await listNotifications({ limit: 20, storeId: b.id }, db);
  assert.deepEqual(inB.map((n) => n.title), ['התאמה בסניף ב'],
    'a cash alert from another branch must not appear, and an untagged one must not either');

  // בלי חנות — הכול. שום התראה לא נעלמת מהמערכת, היא רק לא נתלית על סניף שאולי אינו שלה.
  const all = await listNotifications({ limit: 20 }, db);
  assert.equal(all.length, 3);

  // והרובריקה יודעת לספר שיש ישנות, כדי שמסך ריק לא ייראה כמו "אין התראות".
  const { unscopedNotificationCount, notificationStoreReady } = await import('../src/services/notifications.js');
  assert.equal(await unscopedNotificationCount(['cash_match', 'salary_cleared_unmatched'], db), 1);
  assert.equal(await notificationStoreReady(db), true);
  // …ונעלמת כשהיא נקראה (בעלים, 16/10: "זה יעלם מתישהו?") — אחרת השורה נשארת בלוח הבקרה לתמיד.
  await db.run("UPDATE notifications SET read_at = '2026-10-16 10:00:00' WHERE store_id IS NULL", []);
  assert.equal(await unscopedNotificationCount(['cash_match', 'salary_cleared_unmatched'], db), 0);
});

// בעלים, 16/10: "אם זה הותאם אין טעם להציג אותו". כרטיס "התראות מזומן" בלוח = רק מה שדורש תשומת לב
// (צ׳ק שכר שנפרע לפני התאמה), וכל עוד לא נקרא; "✓ ראיתי" מוציא אותו. התאמות — בפעמון בלבד.
test('dashboard cash alerts: only unread "cleared before matching", never a done match', async () => {
  const db = await freshDb();
  const { owner, firstStore } = await import('./helpers.js');
  const { createApp } = await import('../src/app.js');
  const { createSession } = await import('../src/lib/auth.js');
  const { once } = await import('node:events');
  const o = await owner(db);
  const st = await firstStore(db);
  await recordNotification({ kind: 'cash_match', title: 'הותאם תשלום שכר במזומן', storeId: st.id }, db);
  await recordNotification({ kind: 'salary_cleared_unmatched', title: 'צ׳ק שכר נפרע לפני התאמה', storeId: st.id }, db);
  const kinds = ['salary_cleared_unmatched'];
  const shown = await listNotifications({ limit: 8, storeId: st.id, kinds, unreadOnly: true }, db);
  assert.deepEqual(shown.map((n) => n.title), ['צ׳ק שכר נפרע לפני התאמה']);

  const server = createApp().listen(0); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const cookie = `session=${createSession(o.id)}; ap_store=${st.id}`;
    const dash = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    assert.match(dash, /צ׳ק שכר נפרע לפני התאמה/);
    assert.doesNotMatch(dash, /הותאם תשלום שכר במזומן/, 'a done match is not on the dashboard');
    assert.match(dash, /✓ ראיתי/);
    const r = await fetch(`${base}/notifications/${shown[0].id}/read`, {
      method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ return_to: '/' }).toString(),
    });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/');
    const after = await (await fetch(`${base}/`, { headers: { cookie } })).text();
    assert.doesNotMatch(after, /צ׳ק שכר נפרע לפני התאמה/, 'seen → off the dashboard');
    assert.equal((await listNotifications({ limit: 20 }, db)).length, 2, 'both still in the notifications list');
  } finally { server.close(); }
});
