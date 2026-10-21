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
  const e = await advance('7005', '2026-09-15', 77700);     // the debit carries ANOTHER check number
  await txn('2026-08-26', -1283720, null);                  // no number on the bank row — amount is all there is
  await txn('2026-09-20', -77700, '99005');
  await txn('2026-09-03', -239500, null);
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
  // 🔴 חוק ברזל (21/10): מספר סותר — מוצע לבדיקה, אבל לעולם לא "חד-משמעי" (לא נכנס להתאמה הגורפת).
  assert.equal(m.get(id(e)).candidates.length, 1);
  assert.equal(m.get(id(e)).candidates[0].numberDiffers, true);
  assert.equal(m.get(id(e)).unique, false);
  // the advance shows its supplier (it has no invoice lines)
  const row = detail.find((r) => r.paymentId === id(a));
  assert.equal(row.supplierName, 'משכיר');
  assert.equal(row.isAdvance, true);
});

test('the page offers the match; "match all unique" clears only the one-to-one pair', async () => {
  const html = await (await fetch(`${base}/reports/outstanding?account=${acc.id}`, { headers: { cookie: ck() } })).text();
  // בעלים 21/10: "תמחוק" — שורת הסיכום ("🔎 נמצאו חיובים…" + "התאם את כל החד-משמעיים") ירדה; ההצעות בשורות נשארו.
  assert.doesNotMatch(html, /נמצאו חיובים בבנק|התאם את כל החד-משמעיים|ההתחייבות החיה/);
  assert.match(html, /גם לצ׳ק אחר/);
  assert.match(html, /מספר שונה — לבדוק/);
  const r = await fetch(`${base}/reports/outstanding/match-unique`, {
    method: 'POST', redirect: 'manual', headers: { cookie: ck(), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ account: String(acc.id) }).toString(),
  });
  assert.equal(r.status, 303);
  assert.match(decodeURIComponent(r.headers.get('location')), /הותאמו 1 צ׳קים/);
  const cleared = await db.many("SELECT check_number, status, cleared_date FROM payments WHERE check_number IN ('7001','7002','7003','7005') ORDER BY check_number", []);
  assert.deepEqual(cleared.map((p) => p.status), ['cleared', 'issued', 'issued', 'issued'], '7005 (another number) is not swept in');
  assert.equal(cleared[0].cleared_date, '2026-08-26');
});

test('a single match from the row (the ambiguous one, chosen by the user)', async () => {
  const p = await db.one("SELECT id FROM payments WHERE check_number = '7002'", []);
  const t = await db.one('SELECT id FROM bank_transactions WHERE amount = -239500', []);
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

// בעלים 21/10: "לוותר על [טבלת החשבונות] ומייד להציג את רשימת הצ׳קים" — חוץ ממצב של כמה חנויות; ואחר כך:
// "למעלה משמאל לחזרה — הצג הכל · שבועי · חודשי" (שורת הכותרת), ייצוא והדפסה בסרגל שבתחתית, בלי "תאריכים".
test('outstanding page: one account opens straight into its checks; the cuts sit in the header row, export/print in the bar', async () => {
  const html = await (await fetch(`${base}/reports/outstanding`, { headers: { cookie: ck() } })).text();
  assert.match(html, /פירוט צ׳קים שלא נפרעו/, 'the list, without clicking a row');
  assert.doesNotMatch(html, /<th>חברה<\/th><th>חנות \/ חשבון<\/th>/, 'no one-row accounts table');
  assert.match(html, /class="muted oc-total"/, 'its total moves under the heading');
  const top = html.slice(html.indexOf('class="sb-side sb-start"'), html.indexOf('class="sb-center"'));
  const order = ['>הצג הכל<', '>שבועי<', '>חודשי<'].map((t) => top.indexOf(t));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), 'right to left, left of "→ חזרה": all · weekly · monthly');
  assert.doesNotMatch(html, /תאריכים<\/button>|id="oc-date"/, 'no date cut any more');
  const bar = html.slice(html.indexOf('class="oc-bar"'));
  assert.ok(bar.indexOf('📄 ייצוא CSV') > 0 && bar.indexOf('🖨️ הדפסה / PDF') > bar.indexOf('📄 ייצוא CSV'), 'export · print in the bottom bar');
  assert.match(bar, new RegExp(`href="/reports/outstanding-detail\\.csv\\?account=${acc.id}"`), 'export = the detailed file of the list shown');
  assert.ok(html.indexOf('id="oc-weeks"') > 0 && html.indexOf('id="oc-weeks"') < html.indexOf('פירוט צ׳קים שלא נפרעו'), 'the picker opens at the top of the page');
  assert.match(html, /<div class="table-scroll">\s*<table class="sortable">/, 'the 11-column table scrolls inside itself on a phone');
  // "כל החנויות" (no store cookie) — several accounts: the table stays and no list opens by itself.
  const all = await (await fetch(`${base}/reports/outstanding`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(all, /<th>חברה<\/th><th>חנות \/ חשבון<\/th>/);
  assert.doesNotMatch(all, /oc-detail-head/);
  assert.match(all, /href="\/reports\/outstanding\.csv"/);
});

test('weekly cut: only the checks due in the chosen week (Sunday–Saturday)', async () => {
  const html = await (await fetch(`${base}/reports/outstanding?cut=weeks&weeks=2026-09-13`, { headers: { cookie: ck() } })).text();
  assert.match(html, /<input type="checkbox" name="weeks" value="2026-09-13"[^>]*checked/);
  assert.match(html, /13\/09–19\/09\/26/);
  const body = html.slice(html.indexOf('<tbody>', html.indexOf('oc-detail-head')), html.indexOf('</tbody>', html.indexOf('oc-detail-head')));
  assert.match(body, /15\/09\/26/, '7005 is due 15/09 — inside the week');
  assert.doesNotMatch(body, /10\/09\/26/, '7004 (10/09) is the week before');
  assert.doesNotMatch(body, /01\/09\/26/, '7003 (01/09) is two weeks before');
});
