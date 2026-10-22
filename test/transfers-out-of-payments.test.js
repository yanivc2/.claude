// בעלים 21/10: "העברות שייך להעברות בנקאיות" — העברה ומקבץ יוצאים מטבלת המרקורים, לרובריקה "העברות שבוצעו"
// מתחת ל"בקשות" בדף ההעברות (מיקום ו"גם מקבץ" — תשובות הבעלים).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createPayment } from '../src/services/payments.js';
import { israelToday } from '../src/lib/loginHours.js';

let db, o, A, B, sup, server, base, tr, ba, ck, theirs;
const get = async (p) => (await fetch(base + p, { headers: { cookie: `session=${createSession(o.id)}; ap_store=1` } })).text();
before(async () => {
  db = await freshDb();
  o = await owner(db);
  A = await accountForStore(db, 1);
  B = await accountForStore(db, 3);
  sup = await approveSupplier((await createSupplier({ name: 'ספק העברות' }, o, db)).id, o, db);
  const pay = (acc, method, extra) => createPayment({ bankAccountId: acc.id, method, paymentDate: israelToday(), supplierId: sup.id, amount: 100000, ...extra }, o, db);
  tr = await pay(A, 'transfer', { reference: 'TR-55501' });
  ba = await pay(A, 'batch', { batchNumber: 'MK-9', reference: 'TR-55502' });
  ck = await pay(A, 'check', { checkNumber: '880001' });
  theirs = await pay(B, 'transfer', { reference: 'TR-THEIRS' });
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('מרקורים no longer lists transfers or batches — checks stay', async () => {
  const html = await get('/payments');
  assert.doesNotMatch(html, /TR-55501|TR-55502/);
  assert.match(html, /צ׳ק 880001/);
});

test('"העברות שבוצעו" sits below "בקשות" on the transfers page, with this store\'s transfers and batches only', async () => {
  const html = await get('/transfers');
  const req = html.indexOf('>בקשות</h2>');
  const done = html.indexOf('>העברות שבוצעו <span class="badge b-neutral">2</span></h2>');
  assert.ok(req > 0 && done > req, 'below בקשות');
  const card = html.slice(done, html.indexOf('</table>', done));
  assert.match(card, /העברה · TR-55501/);
  assert.match(card, /מקבץ MK-9 · אסמכתא TR-55502/);
  assert.match(card, new RegExp(`action="/payments/${tr.id}/clear"`), 'same status/actions cell as מרקורים');
  assert.doesNotMatch(card, /880001|TR-THEIRS/, 'no checks, no other store');
  void ba; void ck; void theirs;
});
