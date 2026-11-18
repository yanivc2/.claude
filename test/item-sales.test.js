// 🛒 בעלים 17/11: "בפינק כשיש הוצאות של ג'חנון או של פרחים אני רוצה שיופיע חישוב של מכר מימים שישי שבת
// וראשון שלפני ההוצאה (אם ההוצאה נרשמה ביום ראשון אז להכליל גם את היום ראשון הזה)" — "לייד הסכום שנרשם
// כהוצאת מזומן"; ג'חנון = "גחנון רסק וביצה + ביצה". המקור: דוח "פינק מכר יומי" של הקופה, דרך סקריפט
// הג'ימייל (POST /ingest/item-sales). הקבצים כאן הם הדוחות האמיתיים של שבת 14/11 וראשון 15/11.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { freshDb, owner } from './helpers.js';
import { parseItemSalesPdf, parseItemSalesGrid } from '../src/lib/itemSalesReport.js';
import { groupOfItem, groupOfExpense, weekendBefore } from '../src/lib/trackedItems.js';
import { importItemSales, withItemSales } from '../src/services/itemSales.js';
import { unmatchedCashExpenses } from '../src/services/zreports.js';
import { buildRevenueIngestScript } from '../src/lib/revenueIngestScript.js';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createSession } from '../src/lib/auth.js';

const fixture = (d) => readFileSync(new URL(`./fixtures/items-pink-2026-11-${d}.pdf`, import.meta.url));

test('the real Saturday report: ג\'חנון = 71 "גחנון רסק וביצה" + 8 eggs; פרחים = 9 × ₪30 + 5 × ₪50; the day it prints', async () => {
  const p = await parseItemSalesPdf(fixture('14'));
  assert.equal(p.error, undefined);
  assert.equal(p.date, '2026-11-14');
  assert.equal(p.totalSales, 4585857, '"סה"כ שורות" ₪45,858.57');
  const by = Object.fromEntries(p.tracked.map((t) => [t.code, t]));
  assert.deepEqual([by['2588'].group, by['2588'].qty, by['2588'].sales], ['jachnun', 71, 177500]);
  assert.deepEqual([by['91346728465'].group, by['91346728465'].qty, by['91346728465'].sales], ['jachnun', 8, 2400]);
  assert.deepEqual([by['99134679'].group, by['99134679'].qty, by['99134679'].sales], ['flowers', 9, 27000]);
  assert.deepEqual([by['156473164'].group, by['156473164'].qty, by['156473164'].sales], ['flowers', 5, 25000]);
  assert.equal(p.tracked.length, 4, 'nothing else in the report is counted');
  assert.deepEqual(p.warnings, []);
});

test('the real Sunday report: 2 bouquets, no jachnun', async () => {
  const p = await parseItemSalesPdf(fixture('15'));
  assert.equal(p.date, '2026-11-15');
  assert.deepEqual(p.tracked.map((t) => [t.group, t.qty, t.sales]), [['flowers', 2, 6000]]);
});

test('what counts: by barcode, then by name — not the packaged jachnun, not a rose-scented softener', () => {
  assert.equal(groupOfItem('2588', ''), 'jachnun');
  assert.equal(groupOfItem('7290002512011', "ג'חנון צנעני"), null, 'packaged jachnun of another supplier');
  assert.equal(groupOfItem('7290002651116', "לבדי ג'חנון חמסי"), null);
  assert.equal(groupOfItem('123456', 'זר פרחים 40 ש"ח'), 'flowers', 'a new bouquet price = a new barcode');
  assert.equal(groupOfItem('7290116536927', 'מרכך בדין בריח ורדים'), null);
  assert.equal(groupOfExpense({ purpose: "ג'חנון" })?.key, 'jachnun');
  assert.equal(groupOfExpense({ purpose: 'גחנון שבת' })?.key, 'jachnun');
  assert.equal(groupOfExpense({ payer_name: 'רון', purpose: 'פרחים' })?.key, 'flowers');
  assert.equal(groupOfExpense({ purpose: 'טרה' }), null);
});

test('the weekend before the expense: a Sunday includes itself; Friday/Saturday = the weekend before', () => {
  const w = (d) => weekendBefore(d).days.join(',');
  assert.equal(w('2026-11-15'), '2026-11-13,2026-11-14,2026-11-15', 'Sunday');
  assert.equal(w('2026-11-17'), '2026-11-13,2026-11-14,2026-11-15', 'Tuesday');
  assert.equal(w('2026-11-20'), '2026-11-13,2026-11-14,2026-11-15', 'Friday — this weekend has not ended');
  assert.equal(w('2026-11-21'), '2026-11-13,2026-11-14,2026-11-15', 'Saturday');
  assert.equal(w('2026-11-22'), '2026-11-20,2026-11-21,2026-11-22', 'next Sunday');
});

test('a report of several days is refused; a wrapped description still counts by barcode', () => {
  const head = ['% תרומה', 'רווח כספי', '% רווח', 'סה"כ', 'הנחה', 'מחיר', 'עלות', 'כמות', 'תיאור', 'ברקוד'];
  const grid = (to) => [['דוח מכירות פריטים מפורט בחתך רווח ועלות'], [to, 'עד:', '14/11/2026 00:00:00', 'מתאריך:'], head,
    ['גחנון רסק'], ['3.8 %', '100', '60%', '1,775.00', '0.00', '25.00', '10.000', '71', '2588'], ['וביצה']];
  assert.match(parseItemSalesGrid(grid('16/11/2026 00:00:00')).error, /^period/);
  const one = parseItemSalesGrid(grid('15/11/2026 00:00:00'));
  assert.deepEqual(one.tracked.map((t) => [t.code, t.qty, t.sales]), [['2588', 71, 177500]]);
  assert.equal(parseItemSalesGrid([['דו"ח מכירת פריטים לפי מחלקה'], ['אין נתונים להצגה']]).error, 'not an item-sales report');
});

let db, o, pink, other, server, base;
const savedSecret = config.revenueIngestSecret;
before(async () => {
  db = await freshDb(); o = await owner(db);
  pink = await db.one("SELECT id, name FROM stores WHERE name LIKE 'פינק%'", []);
  other = await db.one("SELECT id FROM stores WHERE name = 'מידנייט'", []);
  config.revenueIngestSecret = 's3cret';
  server = createApp().listen(0); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server && server.close(); config.revenueIngestSecret = savedSecret; });

const post = (qs, buf, secret = 's3cret') => {
  const fd = new FormData();
  fd.append('file', new Blob([buf]), 'פינק מכר יומי.pdf');
  return fetch(`${base}/ingest/item-sales?${qs}`, { method: 'POST', body: fd, headers: secret ? { 'x-ingest-secret': secret } : {} });
};

test('the Gmail script carries "מכר יומי" PDFs to /ingest/item-sales, and back-fills 35 days on install', () => {
  const src = buildRevenueIngestScript({ appUrl: 'https://x.app', secret: 'k' });
  assert.match(src, /return \/מכר יומי\/\.test\(att\.getName\(\)\) && \/\\\.pdf\$\/i\.test\(att\.getName\(\)\);/);
  assert.match(src, /itemReports_\(msg\)\.forEach\(function \(att\) \{ take\(post_\('\/ingest\/item-sales', msg, att\)\); \}\);/);
  assert.match(src, /subject:"מכר יומי" filename:pdf newer_than:35d/);
  assert.match(src, /pullRevenueReports\(\);\n  backfillItemSales\(\);/);
});

test('ingest: the secret is required; the store from the subject; a day sent twice is replaced, not doubled', async () => {
  assert.equal((await post(`store=${pink.id}`, fixture('14'), 'nope')).status, 401);
  await db.run("UPDATE stores SET name = 'פינק' WHERE id = ?", [pink.id]); // the POS branch "4 פינק מרקט" ↔ the store "פינק"
  const subject = encodeURIComponent('[ דו"ח ] 4: פינק מכר יומי סניף: 4 פינק מרקט ');
  const r = await post(`subject=${subject}`, fixture('14'));
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.date, '2026-11-14');
  assert.deepEqual(j.groups, { jachnun: { qty: 79, sales: 179900 }, flowers: { qty: 14, sales: 52000 } });
  const again = await (await post(`store=${pink.id}`, fixture('14'))).json();
  assert.equal(again.replaced, true);
  assert.equal(Number((await db.one('SELECT COUNT(*) AS n FROM pos_item_sales WHERE store_id = ?', [pink.id])).n), 4);
  assert.equal((await post(`store=${pink.id}`, fixture('15'))).status, 200);
  const bad = await post(`store=${pink.id}`, Buffer.from('%PDF-1.4 not really'));
  assert.notEqual(bad.status, 200);
});

const addExpense = async (storeId, day, purpose, agorot) => {
  const z = await db.run("INSERT INTO z_reports (store_id,z_number,z_date,daily_total,drawer_cash,created_by) VALUES (?,?,?,0,0,?)",
    [storeId, String(Math.floor(Math.random() * 90000) + 1000), day, o.id]);
  return Number((await db.run("INSERT INTO z_expenses (z_report_id,expense_date,payer_name,purpose,description_type,amount) VALUES (?,?,'רון',?,'manual',?)",
    [z.lastInsertRowid, day, purpose, agorot])).lastInsertRowid);
};

test('beside the expense: Fri+Sat+Sun before it, the missing Friday said out loud; other stores and other expenses get nothing', async () => {
  const j = await addExpense(pink.id, '2026-11-15', "ג'חנון", 150000);
  const f = await addExpense(pink.id, '2026-11-17', 'פרחים', 40000);
  const t = await addExpense(pink.id, '2026-11-15', 'טרה', 84300);
  const m = await addExpense(other.id, '2026-11-15', "ג'חנון", 50000);
  const rows = await unmatchedCashExpenses(null, 100, null, db);
  const get = (id) => rows.find((r) => r.source === 'zreport' && Number(r.id) === id);
  const js = get(j).itemSales;
  assert.equal(js.group, 'jachnun');
  assert.equal(js.range, 'שישי–ראשון 13/11–15/11');
  assert.deepEqual([js.qty, js.sales], [79, 179900], 'Saturday 71+8; Sunday 0 (report came, nothing sold)');
  assert.deepEqual(js.missing, ['2026-11-13'], 'Friday has no report — not counted as 0');
  assert.deepEqual(js.days.map((d) => d.label), ['שישי 13/11', 'שבת 14/11', 'ראשון 15/11']);
  assert.deepEqual([get(f).itemSales.qty, get(f).itemSales.sales], [16, 58000], 'Tuesday expense → the weekend before: 14 + 2 bouquets');
  assert.equal(get(t).itemSales, undefined);
  assert.equal(get(m).itemSales, undefined, 'a store that never sent the report shows nothing');

  const html = await (await fetch(`${base}/payments`, { headers: { cookie: `session=${createSession(o.id)}` } })).text();
  assert.match(html, /🥙 מכר ג׳חנון שישי–ראשון <bdi dir="ltr" style="white-space:nowrap">13\/11–15\/11<\/bdi>: <strong>79 יח׳ · ₪1,799\.00<\/strong>/);
  assert.match(html, /💐 מכר פרחים שישי–ראשון <bdi dir="ltr" style="white-space:nowrap">13\/11–15\/11<\/bdi>: <strong>16 יח׳ · ₪580\.00<\/strong>/);
  assert.match(html, /חסר דוח: <bdi dir="ltr" style="white-space:nowrap">13\/11\/26<\/bdi>/);
  assert.match(html, /title="שישי 13\/11: חסר דוח · שבת 14\/11: 79 יח׳ · ₪1,799\.00 · ראשון 15\/11: 0 יח׳ · ₪0\.00"/);
});

test('settled and matched rows carry it too (store_id is in those lists now)', async () => {
  const id = await addExpense(pink.id, '2026-11-16', "ג'חנון", 120000);
  await db.run("UPDATE z_expenses SET settled_at = '2026-11-17 10:00:00', settled_by = ? WHERE id = ?", [o.id, id]);
  const { settledCashExpenses } = await import('../src/services/zreports.js');
  const s = (await settledCashExpenses(null, 50, null, db)).find((r) => r.source === 'zreport' && Number(r.id) === id);
  assert.equal(Number(s.store_id), Number(pink.id));
  assert.equal(s.itemSales.qty, 79);
  assert.deepEqual(await withItemSales([], db), []);
});
