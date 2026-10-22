// בעלים 21/10: "מדף מרקורים אפשר לסמן תשלומים לרשויות ולהעביר אותן לטבלת רשויות" + "תשלום לרשויות מתבצע לרוב
// בכרטיס אשראי, לכן בהנפקת התשלום בעצם התשלום התבצע" + (על השורה) "יוצא מהטבלה".
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createPayment } from '../src/services/payments.js';
import { authorityPayments, markPaymentAuthority, authorityPaymentsReady } from '../src/services/authorityPayments.js';
import { israelToday, addDaysIso } from '../src/lib/loginHours.js';

let db, o, A, B, sup, server, base;
const today = israelToday();
const pay = (acc, method, extra, amount) => createPayment({ bankAccountId: acc.id, method, paymentDate: today, supplierId: sup.id, amount, ...extra }, o, db);
const cookie = (u) => `session=${createSession(u.id)}; ap_store=1`;
const post = (u, path, body) => fetch(base + path, {
  method: 'POST', redirect: 'manual',
  headers: { cookie: cookie(u), 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(body).toString(),
});
before(async () => {
  db = await freshDb();
  o = await owner(db);
  A = await accountForStore(db, 1);
  B = await accountForStore(db, 3);
  sup = await approveSupplier((await createSupplier({ name: 'מע"מ חולון' }, o, db)).id, o, db);
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('a credit payment marked for an authority is DONE at once; a check stays open until the bank clears it', async () => {
  assert.equal(await authorityPaymentsReady(db), true);
  const card = await pay(A, 'credit', { cardLast4: '4321' }, 1234500);
  const r = await markPaymentAuthority(card.id, 'vat', o, db);
  assert.equal(r.clearedNow, true);
  const row = await db.one('SELECT status, cleared_date, authority FROM payments WHERE id = ?', [card.id]);
  assert.deepEqual([row.status, row.cleared_date, row.authority], ['cleared', today, 'vat']);

  const chk = await pay(A, 'check', { checkNumber: '777001' }, 50000);
  assert.equal((await markPaymentAuthority(chk.id, 'bituach', o, db)).clearedNow, false);
  assert.equal((await db.one('SELECT status FROM payments WHERE id = ?', [chk.id])).status, 'issued');
  await assert.rejects(markPaymentAuthority(chk.id, 'nope', o, db), /רשות לא מוכרת/);
});

test('it leaves the מרקורים table and appears under "תשלומים לרשויות" — once, even when a bank line was matched to it', async () => {
  const card = await pay(A, 'credit', {}, 222200);
  let html = await (await fetch(`${base}/payments`, { headers: { cookie: cookie(o) } })).text();
  assert.match(html, new RegExp(`action="/payments/${card.id}/authority"`), 'the row offers 🏛️ לרשות');
  assert.match(html, /<option value="">🏛️ לרשות…<\/option>/);

  const r = await post(o, `/payments/${card.id}/authority`, { authority: 'income' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/payments?auth=income&cn=1');
  html = await (await fetch(base + r.headers.get('location'), { headers: { cookie: cookie(o) } })).text();
  assert.doesNotMatch(html, new RegExp(`action="/payments/${card.id}/authority"`), 'gone from מרקורים');
  assert.match(html, /התשלום עבר ל(?:"|&#34;)תשלומים לרשויות(?:"|&#34;) \(דף הספקים\) — מס הכנסה · באשראי: נרשם כבוצע\./);

  // a bank debit that names the authority AND is matched to the marked payment is not counted twice
  const chk = await pay(A, 'check', { checkNumber: '777002' }, 300000);
  await markPaymentAuthority(chk.id, 'bituach', o, db);
  await db.run("INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source, matched_payment_id) VALUES (?, ?, -300000, 'ביטוח לאומי', '777002', 'scraper', ?)", [A.id, today, chk.id]);
  const groups = await authorityPayments({ companyIds: null, storeIds: [1] }, {}, db);
  const bit = groups.find((g) => g.authority === 'ביטוח לאומי');
  assert.equal(bit.items.filter((i) => i.payment_id === chk.id || i.raw_reference === '777002').length, 1);
  const inc = groups.find((g) => g.authority === 'מס הכנסה');
  assert.ok(inc.items.some((i) => i.source === 'payment' && i.payment_id === card.id && i.description === 'מרקורים · אשראי'));

  const sh = await (await fetch(`${base}/suppliers`, { headers: { cookie: cookie(o) } })).text();
  assert.match(sh, new RegExp(`<a href="/payments/${card.id}">מרקורים · אשראי</a>`));
  const back = await post(o, `/payments/${card.id}/authority`, { authority: '', back: 'suppliers' });
  assert.equal(back.headers.get('location'), '/suppliers');
  assert.equal((await db.one('SELECT authority FROM payments WHERE id = ?', [card.id])).authority, null, '↩ למרקורים clears the mark');
});

test('another store\'s payment cannot be marked (404), and only the owner marks', async () => {
  const theirs = await pay(B, 'credit', {}, 10000);
  assert.equal((await post(o, `/payments/${theirs.id}/authority`, { authority: 'vat' })).status, 404);
  const mine = await pay(A, 'credit', {}, 10000);
  const sec = await secretary(db);
  const r = await post(sec, `/payments/${mine.id}/authority`, { authority: 'vat' });
  assert.ok([403, 404].includes(r.status), `secretary refused (${r.status})`);
  assert.equal((await db.one('SELECT authority FROM payments WHERE id = ?', [mine.id])).authority, null);
  void addDaysIso;
});
