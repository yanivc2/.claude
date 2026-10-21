// בעלים 21/10, דף דוחות Z: "הוספת Z" ראשון · "את רשומות Z אחרונות תעביר לסוף" · "העבר את ייצוא לשמאל — ראה תמונה"
// (התא השמאלי של שורת הסה"כ, מתחת לוואטסאפ/מחק).
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

test('rubric order: הוספת Z first, רשומות Z אחרונות last; "ייצוא" goes into the total row\'s leftmost cell', async () => {
  const html = await (await fetch(`${base}/reports/zreports`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=${st.id}` } })).text();
  const at = (s) => { const i = html.indexOf(s); assert.ok(i > 0, s); return i; };
  const add = at('id="zr-add"');
  const recent = at('רשומות Z אחרונות</h2>') ;
  for (const h of ['הצהרות הפקדה</h2>', 'דוחות Z ללא הצהרת הפקדה', 'הפקדה שהוצהרה ולא הופקדה']) {
    assert.ok(add < at(h) && at(h) < recent, `${h} sits between הוספת Z and רשומות Z אחרונות`);
  }
  assert.match(html, /<table class="sortable" data-export-into="zrExportSlot">/);
  const tfoot = html.slice(html.indexOf('<tfoot>', recent), html.indexOf('</tfoot>', recent));
  assert.match(tfoot, /<th class="no-print zr-export-slot" id="zrExportSlot"><\/th>\s*<\/tr>/, 'the last (leftmost) cell of the total row');
});
