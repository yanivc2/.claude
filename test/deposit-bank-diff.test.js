// "חוסר / יתרה" בטבלת הצהרות ההפקדה (דף דוחות Z): מה שהבנק זיכה בפועל מול ההצהרה — הזיכוי ועוד כל
// ביטול/זיכוי-מחדש באותה אסמכתה עד חודש מיום ההצהרה. שורה מאוחרת יותר (מספר שקית שחזר) לא נספרת.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createDeposit, depositVerifications, listDeposits, correctionWindowEnd } from '../src/services/deposits.js';
import { reconcileDeposits } from '../src/services/reconciliation.js';

let server, base, db, o, acc;
const txn = (date, amount, ref) => db.run(
  "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, raw_reference, source) VALUES (?, ?, ?, ?, 'manual')",
  [acc.id, date, amount, ref],
);

before(async () => {
  db = await freshDb();
  o = await owner(db);
  acc = await accountForStore(db, 3);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('the correction window is one calendar month from the declaration (end-of-month clipped)', () => {
  assert.equal(correctionWindowEnd('2026-09-18'), '2026-10-18');
  assert.equal(correctionWindowEnd('2026-01-31'), '2026-02-28');
  assert.equal(correctionWindowEnd('2026-12-15'), '2027-01-15');
});

test('bank reverses and re-credits less → חוסר; a same-ref line after a month is ignored', async () => {
  await createDeposit({ storeId: 3, depositDate: '2026-09-18', bagNumber: '216457968', amount: 2012370 }, o, db);
  await txn('2026-09-19', 2012370, '216457968');      // the credit for the declared amount
  await txn('2026-09-23', -2012370, '216457968');     // counted at the branch: reversal…
  await txn('2026-09-23', 2011370, '216457968');      // …and re-credit ₪10 less
  await txn('2026-11-02', 500000, '216457968');       // a bag number reused later — not this deposit
  await reconcileDeposits(acc.id, o, db);
  const rows = (await listDeposits({ scope: null }, db)).filter((d) => Number(d.store_id) === 3);
  const dep = rows.find((d) => d.bag_number === '216457968');
  const v = (await depositVerifications(rows, db)).get(Number(dep.id));
  assert.equal(v.bankTotal, 2011370);
  assert.equal(v.bankDiff, -1000, 'חוסר ₪10');
  assert.equal(v.corrections.length, 2, 'the November line is outside the month');

  const html = await (await fetch(`${base}/reports/zreports`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=3` } })).text();
  assert.match(html, /<th>סטטוס<\/th><th class="right">חוסר \/ יתרה<\/th>/, 'the new column sits left of status');
  assert.match(html, /חוסר ₪10\.00/);
  assert.match(html, /תוקן בבנק 23\/09\/26/);
});

test('re-credit of more → יתרה; no corrections → תואם; not in the bank yet → —', async () => {
  await createDeposit({ storeId: 3, depositDate: '2026-09-10', bagNumber: '216457965', amount: 315000 }, o, db);
  await txn('2026-09-11', 315000, '216457965');
  await txn('2026-09-14', -315000, '216457965');
  await txn('2026-09-14', 316000, '216457965');
  await createDeposit({ storeId: 3, depositDate: '2026-09-09', bagNumber: '216457944', amount: 909230 }, o, db);
  await txn('2026-09-10', 909230, '216457944');
  await createDeposit({ storeId: 3, depositDate: '2026-10-03', bagNumber: '216499999', amount: 100000 }, o, db);
  await reconcileDeposits(acc.id, o, db);
  const rows = (await listDeposits({ scope: null }, db)).filter((d) => Number(d.store_id) === 3);
  const ver = await depositVerifications(rows, db);
  const by = (bag) => ver.get(Number(rows.find((d) => d.bag_number === bag).id));
  assert.equal(by('216457965').bankDiff, 1000, 'יתרה ₪10');
  assert.equal(by('216457944').bankDiff, 0);
  assert.equal(by('216499999'), undefined, 'not matched in the bank yet');
});

test('דוחות Z: every rubric starts collapsed, with a versioned state key', async () => {
  const html = await (await fetch(`${base}/reports/zreports`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=3` } })).text();
  assert.match(html, /<span data-collapse-default="v2" hidden><\/span>/);
  assert.match(html, /<details class="card collapse no-print" id="zr-add">/, 'the add form is closed (no open attribute)');
  assert.match(html, /<div class="card">\s*<h2>רשומות Z אחרונות/, 'a direct <h2> makes the recent-Z card collapsible');
  const footer = await import('node:fs').then((fs) => fs.readFileSync('src/views/partials/footer.ejs', 'utf8'));
  assert.match(footer, /var pageKey = 'apCollapse:' \+ location\.pathname \+ \(_cdv \? ':' \+ _cdv : ''\);/);
});

test('דוחות Z: totals for "רשומות Z אחרונות" (signed gap) and "הפקדה שהוצהרה ולא הופקדה" (amount)', async () => {
  const { createZReport } = await import('../src/services/zreports.js');
  const { createDeposit: mk } = await import('../src/services/deposits.js');
  const z1 = await createZReport({ storeId: 3, zNumber: '8101', zDate: '2026-09-20', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  const z2 = await createZReport({ storeId: 3, zNumber: '8102', zDate: '2026-09-21', dailyTotal: 100000, drawerCash: 100000 }, o, db);
  await mk({ storeId: 3, zReportId: z1.id, depositDate: '2026-09-20', bagNumber: '81011', amount: 96960 }, o, db); // חוסר 30.40
  await mk({ storeId: 3, zReportId: z2.id, depositDate: '2026-09-21', bagNumber: '81021', amount: 101290 }, o, db); // יתרה 12.90
  const html = await (await fetch(`${base}/reports/zreports`, { headers: { cookie: `session=${createSession(o.id)}; ap_store=3` } })).text();
  const zFoot = html.slice(html.indexOf('דוחות עם הפקדה') - 200, html.indexOf('דוחות עם הפקדה') + 400);
  assert.match(zFoot, /חוסר ₪17\.50/, '−30.40 + 12.90 = −17.50');
  const nd = html.slice(html.indexOf('הפקדה שהוצהרה ולא הופקדה'));
  const foot = nd.slice(nd.indexOf('<tfoot>'), nd.indexOf('</tfoot>'));
  const rows = [...nd.slice(0, nd.indexOf('<tfoot>')).matchAll(/<td class="right">₪([\d,]+\.\d\d)<\/td>/g)].map((m) => Number(m[1].replace(/,/g, '')));
  const sum = rows.reduce((a, b) => a + b, 0);
  assert.ok(rows.length >= 2);
  assert.match(foot, new RegExp(`₪${sum.toLocaleString('en-US', { minimumFractionDigits: 2 }).replace(/\./g, '\\.')}`), 'amount total of the not-deposited bags');
});
