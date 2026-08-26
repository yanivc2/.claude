import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createZReport } from '../src/services/zreports.js';
import { listDeposits } from '../src/services/deposits.js';

// HTTP-level coverage for the deposit-declaration rubric routes. Regression guard: /deposit-declare
// must NOT be captured by the `router.use('/deposits/:id', scopeParam('deposit'))` guard (which once
// 404'd it by reading "declare" as an :id).

let server, base, db, cookie;
const post = (p, b) => fetch(`${base}${p}`, {
  method: 'POST', redirect: 'manual',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(b),
});

before(async () => {
  db = await freshDb();
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = `session=${createSession((await owner(db)).id)}`;
});
after(() => server && server.close());

test('POST /reports/deposit-declare creates a deposit for a Z (not 404)', async () => {
  const store = await firstStore(db);
  const z = await createZReport({ storeId: store.id, zNumber: '950', zDate: '2026-08-05', drawerCash: 50000 }, await owner(db), db);
  const res = await post('/reports/deposit-declare', { z_report_id: String(z.id), bag_number: 'RB-1', amount: '123.45' });
  assert.equal(res.status, 303); // redirect, not 404
  const d = (await listDeposits({ scope: null }, db)).find((x) => x.bag_number === 'RB-1');
  assert.ok(d);
  assert.equal(d.amount, 12345); // ₪123.45 → agorot
  assert.equal(d.deposited, 0); // declared, not yet deposited
});

test('POST /reports/deposits/:id/deposited marks it deposited and can set the scanned bag', async () => {
  const store = await firstStore(db);
  const z = await createZReport({ storeId: store.id, zNumber: '951', zDate: '2026-08-05', drawerCash: 50000 }, await owner(db), db);
  await post('/reports/deposit-declare', { z_report_id: String(z.id), bag_number: 'RB-2', amount: '10' });
  const d = (await listDeposits({ scope: null }, db)).find((x) => x.bag_number === 'RB-2');
  const res = await post(`/reports/deposits/${d.id}/deposited`, { value: '1', bag_number: 'SCANNED-2' });
  assert.equal(res.status, 303);
  const after = (await listDeposits({ scope: null }, db)).find((x) => x.id === d.id);
  assert.equal(after.deposited, 1);
  assert.equal(after.bag_number, 'SCANNED-2'); // barcode value applied
});
