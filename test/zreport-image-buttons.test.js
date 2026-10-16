// דף עריכת דוח Z (בעלים, 16/10): כרטיס "תמונת הדוח" שבתחתית בוטל — במקומו שני כפתורים ליד הכותרת
// "עריכת דוח": 📄 קובץ ו-📷 מצלמה, על טופס העלאה אחד. ההעלאה היא PRG (303) — קודם render במקום
// השאיר את הדפדפן על כתובת POST.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZReport, getZReport } from '../src/services/zreports.js';

let server, base;
before(async () => { server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server && server.close());

// 1×1 PNG
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

test('the image buttons sit by the edit heading, the old card is gone, and upload is PRG', async () => {
  const db = await freshDb();
  const o = await owner(db);
  const st = await firstStore(db);
  const zr = await createZReport({ storeId: st.id, zNumber: '5501', zDate: '2026-10-05', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  const cookie = `session=${createSession(o.id)}`;

  const html = await (await fetch(`${base}/reports/zreports/${zr.id}`, { headers: { cookie } })).text();
  assert.doesNotMatch(html, /תמונת הדוח<\/h2>/, 'the bottom card is removed');
  assert.doesNotMatch(html, /העלה תמונת דוח/);
  const head = html.indexOf('>עריכת דוח</h2>');
  const file = html.indexOf('data-zimg="file"');
  const cam = html.indexOf('data-zimg="camera"');
  const form = html.indexOf('<form class="zform"') > 0 ? html.indexOf('<form class="zform"') : html.indexOf('action="/reports/zreports/' + zr.id + '"');
  assert.ok(head > 0 && file > head && cam > file, 'both buttons right after the heading');
  assert.ok(form > cam, 'before the edit form');
  assert.match(html, /<form method="post" action="\/reports\/zreports\/\d+\/image" enctype="multipart\/form-data" id="zimg-form" data-busy="[^"]+" hidden>/);
  assert.doesNotMatch(html, /צפה בתמונת הדוח/, 'no view button before there is an image');

  const fd = new FormData();
  fd.append('image', new Blob([PNG], { type: 'image/png' }), 'z.png');
  const r = await fetch(`${base}/reports/zreports/${zr.id}/image`, { method: 'POST', redirect: 'manual', headers: { cookie }, body: fd });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(decodeURIComponent(loc), /^\/reports\/zreports\/\d+\?notice=תמונת הדוח נשמרה/);
  assert.ok((await getZReport(zr.id, db)).image_path, 'saved');
  const back = await (await fetch(`${base}${loc}`, { headers: { cookie } })).text();
  assert.match(back, /תמונת הדוח נשמרה/);
  assert.match(back, /צפה בתמונת הדוח/, 'the 🖼️ view button appears once there is an image');

  const empty = await fetch(`${base}/reports/zreports/${zr.id}/image`, { method: 'POST', redirect: 'manual', headers: { cookie }, body: new FormData() });
  assert.equal(empty.status, 303);
  assert.match(decodeURIComponent(empty.headers.get('location')), /\?err=לא נבחר קובץ/);
});
