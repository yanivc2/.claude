// "דוח פדיון" — parsing the nightly report, the profitability column/summing, and email ingestion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { parseRevenueReport, parseRevenueReportAny, reportRangeFromGrid, normalizeReportDate } from '../src/lib/revenueReportFile.js';
import { importRevenueRows, revenueInRange, listRevenue, revenueChecks } from '../src/services/revenueReports.js';
import { looksLikePdf, pdfGrid } from '../src/lib/pdfGrid.js';
import { profitability } from '../src/services/reports.js';

const csv = (s) => Buffer.from(s, 'utf8');

test('parser auto-detects Hebrew headers and sums repeated days', () => {
  const buf = csv(['תאריך,סה"כ מכירות,סליקות אשראי', '01/09/2026,1000.50,600', '01/09/2026,500,400', '02/09/2026,2000,1500'].join('\n'));
  const { rows, warnings } = parseRevenueReport(buf);
  assert.equal(warnings.length, 0);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { date: '2026-09-01', gross: 150050, credit: 100000 }); // agorot, two rows summed
  assert.deepEqual(rows[1], { date: '2026-09-02', gross: 200000, credit: 150000 });
});

test('parser skips title rows above the header and reports unknown columns', () => {
  const withTitle = csv(['דוח פדיון יומי — מידנייט,,', ',,', 'תאריך,פדיון,אשראי', '03/09/2026,120,80'].join('\n'));
  const { rows } = parseRevenueReport(withTitle);
  assert.deepEqual(rows, [{ date: '2026-09-03', gross: 12000, credit: 8000 }]);

  const noCredit = parseRevenueReport(csv(['תאריך,פדיון', '04/09/2026,90'].join('\n')));
  assert.deepEqual(noCredit.rows, [{ date: '2026-09-04', gross: 9000, credit: 0 }]);
  assert.ok(noCredit.warnings.some((w) => /אשראי/.test(w)));
});

test('an explicit column mapping overrides detection (unknown report format)', () => {
  const odd = csv(['col1,col2,col3', '05/09/2026,7,250'].join('\n'));
  const { rows } = parseRevenueReport(odd, { date: 0, sales: 2, credit: -1 });
  assert.deepEqual(rows, [{ date: '2026-09-05', gross: 25000, credit: 0 }]);
});

test('normalizeReportDate handles day-first, ISO and Excel serials', () => {
  assert.equal(normalizeReportDate('31/08/2026'), '2026-08-31');
  assert.equal(normalizeReportDate('2026-08-31'), '2026-08-31');
  assert.equal(normalizeReportDate('1.9.26'), '2026-09-01');
  assert.equal(normalizeReportDate('לא תאריך'), null);
});

test('import is idempotent per day and the range column sums + drives profit', async () => {
  const db = await freshDb();
  const own = await owner(db);
  const st = await firstStore(db);

  const first = await importRevenueRows(st.id, [
    { date: '2026-09-01', gross: 100000, credit: 60000 },
    { date: '2026-09-02', gross: 200000, credit: 150000 },
  ], 'upload', own, db);
  assert.deepEqual(first, { inserted: 2, updated: 0, detailsSaved: true });

  // Re-importing the same day replaces it (the report is the source of truth).
  const again = await importRevenueRows(st.id, [{ date: '2026-09-01', gross: 111000, credit: 61000 }], 'email', own, db);
  assert.deepEqual(again, { inserted: 0, updated: 1, detailsSaved: true });

  const inRange = await revenueInRange('2026-09-01', '2026-09-02', db);
  assert.deepEqual(inRange.get(st.id), { sales: 311000, credit: 211000, days: 2 });
  // A narrower range sums only its days.
  assert.equal((await revenueInRange('2026-09-02', '2026-09-02', db)).get(st.id).sales, 200000);

  // Profitability: the store now reports revenue, so הכנסות/רווח come from it (not the Z totals).
  const { stores } = await profitability('2026-09-01', '2026-09-02', null, db);
  const row = stores.find((s) => s.id === st.id);
  assert.equal(row.revenueSales, 311000);
  assert.equal(row.revenueCredit, 211000);
  assert.equal(row.revenueDays, 2);
  assert.equal(row.usesRevenue, true);
  assert.equal(row.sales, 311000);
  assert.equal(row.grossProfit, 311000 - row.purchases);

  // A store with no report keeps the Z-based behaviour (no regression).
  const other = stores.find((s) => s.id !== st.id);
  if (other) { assert.equal(other.usesRevenue, false); assert.equal(other.sales, other.zSales); }

  assert.equal((await listRevenue({ storeId: st.id }, db)).length, 2);
});

// ---- email ingestion endpoint -------------------------------------------------------------
// The app resolves the executor per request, so this test seeds its OWN fresh DB (making it the
// current default) and asserts against that same handle — otherwise an earlier test's freshDb()
// would leave the server writing to a different database than we read.
let server, base;
before(async () => {
  server = createApp().listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server && server.close());

function form(fileBody, name = 'report.csv') {
  const fd = new FormData();
  fd.append('attachment', new Blob([fileBody], { type: 'text/csv' }), name);
  return fd;
}

test('ingest endpoint: disabled without a secret, refuses a wrong one, imports with the right one', async () => {
  const saved = config.revenueIngestSecret;
  const db = await freshDb();
  const st = await firstStore(db);
  try {
    config.revenueIngestSecret = null;
    let r = await fetch(`${base}/ingest/revenue-report?store=${st.id}`, { method: 'POST', body: form('x') });
    assert.equal(r.status, 503); // disabled by default — never open

    config.revenueIngestSecret = 's3cret';
    r = await fetch(`${base}/ingest/revenue-report?store=${st.id}&secret=nope`, { method: 'POST', body: form('x') });
    assert.equal(r.status, 401);

    const body = form(['תאריך,פדיון,אשראי', '10/09/2026,300,120'].join('\n'));
    r = await fetch(`${base}/ingest/revenue-report?store=${st.id}&secret=s3cret`, { method: 'POST', body });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.deepEqual({ ok: j.ok, inserted: j.inserted, updated: j.updated, days: j.days }, { ok: true, inserted: 1, updated: 0, days: 1 });

    const got = await revenueInRange('2026-09-10', '2026-09-10', db);
    assert.deepEqual(got.get(st.id), { sales: 30000, credit: 12000, days: 1 });
  } finally {
    config.revenueIngestSecret = saved;
  }
});

// ---- the REAL nightly report from the POS (legacy .xls, JasperReports) ----------------------
// Shape: one business day, RTL label→value rows, NO date anywhere in the file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readXls, looksLikeXls } from '../src/lib/xlsRead.js';

const realReport = () => readFileSync(fileURLToPath(new URL('./fixtures/revenue-midnight.xls', import.meta.url)));

test('legacy .xls (OLE2/BIFF) is recognised and decoded into a grid', () => {
  const buf = realReport();
  assert.equal(looksLikeXls(buf), true);
  const grid = readXls(buf);
  assert.ok(grid.length > 20);
  assert.ok(grid.some((r) => r.some((c) => String(c).includes('סה"כ פדיון'))));
});

// מידנייט, 31/08: sales incl. on-account ₪35,028.74 (+ ₪601 debts paid in cash → פדיון ₪35,455.84).
const MIDNIGHT = {
  gross: 3502874, credit: 2340164, cash: 1145320, onAccount: 17390, debtPayments: 60100, debtCredit: 0,
  cards: [
    { name: 'לאומי קארד', sales: 2238368, debt: 0, total: 2238368, count: 344 },
    { name: 'כ.א.ל', sales: 67264, debt: 0, total: 67264, count: 11 },
    { name: 'ישראכרט', sales: 34532, debt: 0, total: 34532, count: 6 },
  ],
  cardsTotal: 2340164, txnCount: 592, cancelAmount: 7500, cancelCount: 2,
};

test('the real midnight report: sales (incl. הקפה, NOT debts paid), tenders, acquirers, cancellations, transactions; needs a date', () => {
  const buf = realReport();
  const noDate = parseRevenueReport(buf);
  assert.equal(noDate.kind, 'summary');
  assert.deepEqual(noDate.summary, MIDNIGHT);
  assert.equal(noDate.rows.length, 0);
  assert.ok(noDate.warnings.some((w) => /תאריך/.test(w)));

  const withDate = parseRevenueReport(buf, { reportDate: '2026-08-31' });
  const { cardsTotal, ...row } = MIDNIGHT; // eslint-disable-line no-unused-vars
  assert.deepEqual(withDate.rows, [{ date: '2026-08-31', ...row }]);
});

test('the real report imports and drives the profitability column', async () => {
  const db = await freshDb();
  const own = await owner(db);
  const st = await firstStore(db);
  const { rows } = parseRevenueReport(realReport(), { reportDate: '2026-08-31' });
  await importRevenueRows(st.id, rows, 'upload', own, db);

  const { stores } = await profitability('2026-08-31', '2026-08-31', null, db);
  const row = stores.find((s) => s.id === st.id);
  assert.equal(row.revenueSales, 3502874, 'what was sold that day — debts collected for earlier sales are not counted again');
  assert.equal(row.revenueCredit, 2340164);
  assert.equal(row.usesRevenue, true);
  assert.equal(row.sales, 3502874);
});

// ---- the same Pidion_A4 report as PDF (ג'וניור, 17/10) — owner, 18/10: "שתהיה אפשרות גם לאקסל וגם לפידיאפ"
const junior = (ext) => readFileSync(fileURLToPath(new URL(`./fixtures/revenue-junior.${ext}`, import.meta.url)));
const JUNIOR = {
  gross: 6666979, credit: 4009639, cash: 2657340, onAccount: 0, debtPayments: 0, debtCredit: 0,
  cards: [
    { name: 'לאומי קארד', sales: 3810716, debt: 0, total: 3810716, count: 677 },
    { name: 'ישראכרט', sales: 104708, debt: 0, total: 104708, count: 23 },
    { name: 'כ.א.ל', sales: 94215, debt: 0, total: 94215, count: 16 },
  ],
  cardsTotal: 4009639, txnCount: 1283, cancelAmount: 62584, cancelCount: 22,
};

test('PDF: the cells are rebuilt from text positions into the same grid as the XLS', async () => {
  const buf = junior('pdf');
  assert.equal(looksLikePdf(buf), true);
  assert.equal(looksLikePdf(junior('xls')), false);
  const grid = await pdfGrid(buf);
  assert.ok(grid.some((r) => r.join('|') === '60.14 %|40096.39 ₪|716|כרטיס אשראי'), 'label right-most, figures to its left');
  assert.deepEqual(reportRangeFromGrid(grid), { from: '2026-10-17', to: '2026-10-18', date: '2026-10-17' });
});

test('PDF and XLS of the same day parse to the same figures; the PDF also knows its day', async () => {
  const pdf = await parseRevenueReportAny(junior('pdf'));
  const xls = await parseRevenueReportAny(junior('xls'));
  assert.deepEqual(pdf.summary, JUNIOR);
  assert.deepEqual(xls.summary, JUNIOR);
  assert.equal(pdf.fileDate, '2026-10-17');
  assert.equal(pdf.rows.length, 1, 'no date needed from the caller');
  assert.equal(pdf.rows[0].date, '2026-10-17');
  assert.equal(xls.rows.length, 0, 'the XLS still has no date of its own');
  // A caller's date that disagrees loses to the file, and says so.
  const other = await parseRevenueReportAny(junior('pdf'), { reportDate: '2026-10-10' });
  assert.equal(other.rows[0].date, '2026-10-17');
  assert.ok(other.warnings.some((w) => /17\/10\/2026/.test(w) && /10\/10\/2026/.test(w)));
});

test('the report day: same date or to the next midnight = one day; longer = refused, never filed under one day', () => {
  const g = (from, to) => [[to, 'עד:', from, 'מתאריך:']];
  assert.equal(reportRangeFromGrid(g('17/10/26 00:00:00', '18/10/26 00:00:00')).date, '2026-10-17');
  assert.equal(reportRangeFromGrid(g('16/10/26 00:00:00', '16/10/26 23:59:00')).date, '2026-10-16');
  assert.equal(reportRangeFromGrid(g('15/10/26 00:00:00', '18/10/26 00:00:00')).date, null);
  assert.equal(reportRangeFromGrid(g('17/10/26 00:00:00', '18/10/26 06:00:00')).date, null, 'past midnight = two business days');
  assert.equal(reportRangeFromGrid([['דוח פדיון']]), null);
});

test('a PDF that is broken, has no text (a scan), or is another report is refused with a reason — never a 500', async () => {
  const broken = await parseRevenueReportAny(junior('pdf').subarray(0, 0x400));
  assert.deepEqual([broken.kind, broken.rows.length], ['unknown', 0]);
  assert.match(broken.warnings[0], /פגום/);
  const blank = Buffer.from('%PDF-1.4\n1 0 obj <</Type/Catalog/Pages 2 0 R>> endobj\n2 0 obj <</Type/Pages/Kids[3 0 R]/Count 1>> endobj\n3 0 obj <</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>> endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n');
  assert.match((await parseRevenueReportAny(blank)).warnings[0], /אין טקסט/);
});

test('the checks: drawer credit (card sales + card debts) against the acquirers, and debts paid', () => {
  assert.deepEqual(revenueChecks({ credit_total: 4009639, debt_credit: 0, debt_payments: 0, cards: JSON.stringify(JUNIOR.cards) }).creditGap, 0);
  const gap = revenueChecks({ credit_total: 4000000, debt_credit: 5000, debt_payments: 5000, cards: JSON.stringify(JUNIOR.cards) });
  assert.equal(gap.creditGap, 4009639 - 4005000);
  assert.equal(gap.debt, 5000);
  assert.deepEqual(revenueChecks({ credit_total: 100, cards: null }), { cards: [], cardsTotal: null, creditGap: null, debt: 0 }, 'an old row: no check, not a false alarm');
});

test('details are stored and replaced with the day; a not-upgraded DB keeps פדיון+אשראי and says the rest was dropped', async () => {
  const db = await freshDb();
  const own = await owner(db);
  const st = await firstStore(db);
  const { rows } = await parseRevenueReportAny(junior('pdf'));
  assert.deepEqual(await importRevenueRows(st.id, rows, 'upload', own, db), { inserted: 1, updated: 0, detailsSaved: true });
  const [got] = await listRevenue({ storeId: st.id }, db);
  assert.equal(Number(got.cash_total), 2657340);
  assert.equal(Number(got.txn_count), 1283);
  assert.equal(Number(got.cancel_amount), 62584);
  assert.equal(Number(got.cancel_count), 22);
  assert.deepEqual(got.checks.cards, JUNIOR.cards);
  assert.equal(got.checks.creditGap, 0);
  // A per-day table row for the same day replaces it — the stale details go too.
  await importRevenueRows(st.id, [{ date: '2026-10-17', gross: 100, credit: 50 }], 'upload', own, db);
  const [plain] = await listRevenue({ storeId: st.id }, db);
  assert.equal(plain.cash_total, null);
  assert.equal(plain.cards, null);

  const oldDb = { ...db, one: db.one.bind(db), run: db.run.bind(db),
    many: (sql, p) => (/cash_total/.test(sql) ? Promise.reject(new Error('no such column: cash_total')) : db.many(sql, p)) };
  const res = await importRevenueRows(st.id, [{ ...rows[0], date: '2026-10-16' }], 'email', own, oldDb);
  assert.deepEqual(res, { inserted: 1, updated: 0, detailsSaved: false });
  const saved = await db.one('SELECT gross_sales, cash_total FROM revenue_reports WHERE store_id = ? AND report_date = ?', [st.id, '2026-10-16']);
  assert.equal(Number(saved.gross_sales), 6666979);
  assert.equal(saved.cash_total, null);
});
