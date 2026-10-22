// בעלים 21/10: "בדף סגירת Z את כפתורי ייצוא העבר לימין לכותרת של הטבלה" (צילום "הוצאות מזומן אחרונות").
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

let o, st, server, base, db;
before(async () => {
  db = await freshDb();
  o = await owner(db);
  st = await firstStore(db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('each recent-Z rubric carries its table\'s "ייצוא" slot as the first thing in its heading', async () => {
  const html = await (await fetch(`${base}/zclosing`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
  for (const [id, title] of [['zcxExport', 'הוצאות מזומן אחרונות'], ['zclExport', 'סגירות אחרונות']]) {
    assert.match(html, new RegExp(`<summary class="sum-start"><span class="sum-export no-print" id="${id}" onclick="event.preventDefault\\(\\)"></span>${title}</summary>`));
    assert.match(html, new RegExp(`<table class="[^"]*" data-export-into="${id}">`), `${title}: the table sends its export to the heading`);
  }
});
