// בעלים 21/10: "בדף ספקים פתח לי רובריקה בשם תשלומים לרשויות" — תשלומים שיצאו מהבנק, מעל טבלת הספקים.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, secretary, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { authorityOf, authorityPayments } from '../src/services/authorityPayments.js';
import { israelToday, addDaysIso } from '../src/lib/loginHours.js';

let db, o, A, B, server, base;
const debit = (acc, date, amount, description) => db.run(
  "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, description, raw_reference, source) VALUES (?, ?, ?, ?, '1', 'scraper')",
  [acc.id, date, amount, description],
);
before(async () => {
  db = await freshDb();
  o = await owner(db);
  A = await accountForStore(db, 1);
  B = await accountForStore(db, 3);
  const d = (n) => addDaysIso(israelToday(), -n);
  await debit(A, d(3), -1539000, 'ביטוח לאומי — עבור: יניב רום יזמות ב מזהה 918067745');
  await debit(A, d(4), -7325000, 'מע"מ — עבור: יניב רום יזמות ב מזהה 515325405');
  await debit(A, d(5), -2563600, 'מס הכנסה עצמאי — עבור: יניב');
  await debit(A, d(6), -500000, 'שיק');
  await debit(A, d(7), -100000, 'מעמד אישי');
  await debit(B, d(3), -99900, 'ארנונה עיריית חולון');
  await debit(A, d(500), -100000, 'ביטוח לאומי'); // older than 12 months
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('recognised by whole words in the bank description — never by abbreviation or a word that only starts the same', () => {
  assert.equal(authorityOf('ביטוח לאומי — עבור: יניב')?.name, 'ביטוח לאומי');
  assert.equal(authorityOf('בטוח לאומי')?.name, 'ביטוח לאומי');
  assert.equal(authorityOf('מס הכנסה עצמאי')?.name, 'מס הכנסה');
  assert.equal(authorityOf('מע״מ')?.name, 'מע"מ');
  assert.equal(authorityOf('רשות המסים')?.name, 'רשות המסים');
  assert.equal(authorityOf('ארנונה עיריית חולון')?.name, 'ארנונה / עירייה');
  assert.equal(authorityOf('מעמד אישי'), null);
  assert.equal(authorityOf('שיק'), null);
});

test('grouped by month · authority · account, last 12 months, only the accounts in scope', async () => {
  const all = await authorityPayments(null, {}, db);
  assert.deepEqual(all.map((g) => g.authority).sort(), ['ארנונה / עירייה', 'ביטוח לאומי', 'מס הכנסה', 'מע"מ'].sort());
  assert.equal(all.find((g) => g.authority === 'מע"מ').total, 7325000);
  const storeA = await authorityPayments({ companyIds: [A.company_id], storeIds: [1] }, {}, db);
  assert.ok(storeA.every((g) => g.account === A.display_name), 'another store\'s account stays out');
});

test('the owner sees the card above the suppliers table, closed; others do not see it', async () => {
  const html = await (await fetch(`${base}/suppliers`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=1` } })).text();
  const card = html.indexOf('<summary>תשלומים לרשויות');
  assert.ok(card > 0 && card < html.indexOf('action="/suppliers/bulk"'), 'above the table');
  assert.match(html, /<details class="card no-print collapse-card authority-card">/, 'closed by default');
  assert.match(html, /— 3 חיובים · ₪114,276\.00 · 12 החודשים האחרונים/, "the active store: 15,390 + 73,250 + 25,636");
  const sec = await secretary(db);
  await db.run(`UPDATE users SET permissions = '["nav_suppliers"]' WHERE id = ?`, [sec.id]);
  const other = await (await fetch(`${base}/suppliers`, { headers: { cookie: `session=${createSession(sec.id)}` } })).text();
  assert.doesNotMatch(other, /תשלומים לרשויות/);
});
