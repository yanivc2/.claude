// "דוח פדיון" — parsing the nightly report, the profitability column/summing, and email ingestion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { freshDb, owner, firstStore } from './helpers.js';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { parseRevenueReport, normalizeReportDate } from '../src/lib/revenueReportFile.js';
import { importRevenueRows, revenueInRange, listRevenue } from '../src/services/revenueReports.js';
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
  assert.deepEqual(first, { inserted: 2, updated: 0 });

  // Re-importing the same day replaces it (the report is the source of truth).
  const again = await importRevenueRows(st.id, [{ date: '2026-09-01', gross: 111000, credit: 61000 }], 'email', own, db);
  assert.deepEqual(again, { inserted: 0, updated: 1 });

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
    assert.deepEqual(await r.json(), { ok: true, inserted: 1, updated: 0, days: 1 });

    const got = await revenueInRange('2026-09-10', '2026-09-10', db);
    assert.deepEqual(got.get(st.id), { sales: 30000, credit: 12000, days: 1 });
  } finally {
    config.revenueIngestSecret = saved;
  }
});
