// בעלים 22/10: "סמן הכל כנקרא — שים בשורה של הודעה בעמודה של סימון כנקרא".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { recordNotification, markAllNotificationsRead } from '../src/services/notifications.js';

let db, o, server, base;
before(async () => {
  db = await freshDb(); o = await owner(db);
  await recordNotification({ title: 'בדיקת התראה' }, db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());
const page = async () => (await fetch(`${base}/notifications`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();

test('"סמן הכל כנקרא" sits in the header of the "סמן כנקרא" column, not in the toolbar; gone once all are read', async () => {
  let html = await page();
  const head = html.slice(html.indexOf('<thead>'), html.indexOf('</thead>'));
  assert.match(head, /<th>מתי<\/th><th>הודעה<\/th><th data-nosort data-nofilter data-noexport class="no-print notif-readall">\s*<form method="post" action="\/notifications\/read-all"[^>]*>\s*<button type="submit" class="btn btn-secondary btn-sm">סמן הכל כנקרא<\/button>/);
  const toolbar = html.slice(html.indexOf('<div class="toolbar">'), html.indexOf('</div>', html.indexOf('<div class="toolbar">')));
  assert.doesNotMatch(toolbar, /סמן הכל כנקרא/);
  await markAllNotificationsRead(db);
  html = await page();
  assert.doesNotMatch(html, /סמן הכל כנקרא/);
});
