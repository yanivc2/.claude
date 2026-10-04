// "צ׳קים בחוץ" — התאמה לפי סכום: צ׳ק פתוח שהבנק כבר חייב באותו סכום (בלי מספר צ׳ק תואם, ולכן
// ההתאמה האוטומטית לא תפסה אותו) מוצע להתאמה; "התאם את כל החד-משמעיים" מתאים רק זוגות שבהם הצ׳ק
// הוא היחיד לתנועה והתנועה היחידה לצ׳ק.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, accountForStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';
import { createSupplier, approveSupplier } from '../src/services/suppliers.js';
import { createPayment } from '../src/services/payments.js';
import { outstandingCheckDetail, outstandingBankCandidates } from '../src/services/reports.js';

let server, base, db, o, acc, sup;
const ck = () => `session=${createSession(o.id)}; ap_store=3`;
const txn = (date, amount, ref = null) => db.run(
  "INSERT INTO bank_transactions (bank_account_id, txn_date, amount, raw_reference, source) VALUES (?, ?, ?, ?, 'manual')",
  [acc.id, date, amount, ref],
);
const advance = (no, date, amount) => createPayment({ bankAccountId: acc.id, method: 'check', checkNumber: no, paymentDate: date, supplierId: sup.id, amount }, o, db);

before(async () => {
  db = await freshDb();
  o = await owner(db);
  acc = await accountForStore(db, 3);
  sup = await approveSupplier((await createSupplier({ name: 'משכיר' }, o, db)).id, o, db);
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

test('candidates: same amount, unmatched debit, inside the window; unique only when one-to-one', async () => {
  const a = await advance('7001', '2026-08-24', 1283720);   // unique match
  const b = await advance('7002', '2026-09-01', 239500);    // two checks of the same amount…
  const c = await advance('7003', '2026-09-01', 239500);    // …and one debit → offered, not unique
  const d = await advance('7004', '2026-09-10', 563400);    // the only debit is outside the window
  await txn('2026-08-26', -1283720, '99001');
  await txn('2026-09-03', -239500, '99002');
  await txn('2027-06-01', -563400, '99003');
  await txn('2026-09-12', 563400, '99004');                 // a CREDIT of the same amount — never a candidate
  const detail = await outstandingCheckDetail(acc.id, {}, db);
  const m = await outstandingBankCandidates(acc.id, detail, db);
  const id = (p) => Number(p.id ?? p.payment?.id ?? p.paymentId);
  assert.equal(m.get(id(a)).candidates.length, 1);
  assert.equal(m.get(id(a)).unique, true);
  assert.equal(m.get(id(b)).candidates.length, 1);
  assert.equal(m.get(id(b)).unique, false, 'the debit is a candidate for two checks');
  assert.equal(m.get(id(c)).unique, false);
  assert.equal(m.get(id(d)).candidates.length, 0, 'beyond 180 days after the due date');
  // the advance shows its supplier (it has no invoice lines)
  const row = detail.find((r) => r.paymentId === id(a));
  assert.equal(row.supplierName, 'משכיר');
  assert.equal(row.isAdvance, true);
});

test('the page offers the match; "match all unique" clears only the one-to-one pair', async () => {
  const html = await (await fetch(`${base}/reports/outstanding?account=${acc.id}`, { headers: { cookie: ck() } })).text();
  assert.match(html, /נמצאו חיובים בבנק <strong>באותו סכום<\/strong>/);
  assert.match(html, /התאם את כל החד-משמעיים \(1\)/);
  assert.match(html, /גם לצ׳ק אחר/);
  const r = await fetch(`${base}/reports/outstanding/match-unique`, {
    method: 'POST', redirect: 'manual', headers: { cookie: ck(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: String(acc.id) }).toString(),
  });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /הותאמו 1 צ׳קים/);
  const cleared = await db.many("SELECT check_number, status, cleared_date FROM payments WHERE check_number IN ('7001','7002','7003') ORDER BY check_number", []);
  assert.deepEqual(cleared.map((p) => p.status), ['cleared', 'issued', 'issued']);
  assert.equal(cleared[0].cleared_date, '2026-08-26');
});

test('a single match from the row (the ambiguous one, chosen by the user)', async () => {
  const p = await db.one("SELECT id FROM payments WHERE check_number = '7002'", []);
  const t = await db.one("SELECT id FROM bank_transactions WHERE raw_reference = '99002'", []);
  const r = await fetch(`${base}/reports/outstanding/match`, {
    method: 'POST', redirect: 'manual', headers: { cookie: ck(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: String(acc.id), payment_id: String(p.id), txn_id: String(t.id) }).toString(),
  });
  assert.equal(r.status, 303);
  assert.equal((await db.one('SELECT status FROM payments WHERE id = ?', [p.id])).status, 'cleared');
  // the debit is taken now — 7003 has no candidate left
  const detail = await outstandingCheckDetail(acc.id, {}, db);
  const m = await outstandingBankCandidates(acc.id, detail, db);
  const c = await db.one("SELECT id FROM payments WHERE check_number = '7003'", []);
  assert.equal(m.get(Number(c.id)).candidates.length, 0);
});
