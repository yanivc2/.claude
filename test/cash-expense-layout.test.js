// The cash-expenses rubric appears on FOUR screens. It must be one layout on all of them.
//
// History this pins down: the cramped 6-column table was replaced with the stacked labeled-card
// layout (.cx-list/.cx-row/.cx-field) on the Z-closing ENTRY form and on the Z-report form — and
// the Z-closing EDIT form was missed. On a phone its six columns squeezed every control to a few
// characters wide and the day-first date popover opened clipped inside .table-scroll. Nothing
// caught it because no test looked at the layout, only at the field names.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZClosing } from '../src/services/zclosing.js';
import { createZReport } from '../src/services/zreports.js';

let server, base, headers, paths;

before(async () => {
  const x = await freshDb();
  const o = await owner(x);
  const store = await firstStore(x);
  const closingId = await createZClosing(
    {
      employeeFirst: 'רון', employeeLast: 'לוי', storeId: store.id, zNumber: '970',
      drawerCash: 10000, startedAt: '2026-08-13 09:00', counts: { 100: 1 },
      expenses: [{ kind: 'manual', payerName: 'רון לוי', purpose: 'קפה', amount: 1200 }],
    },
    o, x,
  );
  const zr = await createZReport(
    { storeId: store.id, zNumber: '971', zDate: '2026-08-21', dailyTotal: 100000, drawerCash: 100000 },
    o, x,
  );
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  headers = { cookie: `session=${encodeURIComponent(createSession(o.id))}` };
  paths = ['/zclosing', `/zclosing/${closingId}`, '/reports/zreports', `/reports/zreports/${zr.id}`];
});

after(() => server && server.close());

test('every cash-expenses form uses the stacked card layout — never a table', async () => {
  for (const path of paths) {
    const html = await (await fetch(base + path, { headers })).text();
    assert.ok(html.includes('id="cx-body" class="cx-list"'), `${path}: expense rows are a .cx-list`);
    assert.ok(html.includes('class="cx-row"'), `${path}: each expense is a stacked card`);
    assert.ok(!/<tbody id="cx-body"/.test(html), `${path}: the cramped table layout is gone`);
    // The roomy fields carry their own labels — that is what makes them readable on a phone.
    assert.ok(html.includes('class="cx-field cx-amt-field"'), `${path}: the amount field is the roomy one`);
    assert.ok(html.includes('class="cx-field cx-details"'), `${path}: details sit on their own line`);
  }
});
