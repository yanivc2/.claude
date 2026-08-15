import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsx } from '../src/lib/xlsxRead.js';
import { readXlsxRows, readCsvRows, readCatalogRows, uploadCatalog, summaryText } from '../src/public/catalog-upload.js';
import { book } from './fixtures/xlsx.js';

// public/catalog-upload.js runs in the browser, but everything it needs — Blob,
// DecompressionStream, TextDecoderStream — is a Node global too, so the real module is exercised
// here rather than a stand-in. Its DOM wiring is skipped automatically (no `document`).

/** Drain an async generator into an array. */
async function collect(gen) {
  const out = [];
  for await (const row of gen) out.push(row);
  return out;
}

const SHEET =
  '<worksheet><dimension ref="A1:C4"/><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>5.5</v></c></row>' +
  '<row r="3"><c r="A3" s="4"/><c r="B3" t="s"><v>3</v></c></row>' +
  '<row r="4"><c r="C4"><v>7</v></c></row>' +
  '</sheetData></worksheet>';

test('the browser reader and the server reader agree, row for row', async () => {
  // The whole point of the twin implementations: same bytes in, same rows out. Includes the two
  // cases that broke positional mapping on the real upload — a blank leading cell (row 3) and a
  // row that starts at column C (row 4).
  const buf = book(SHEET);
  const mine = await collect(readXlsxRows(new Blob([buf])));
  assert.deepEqual(mine, readXlsx(buf));
  assert.deepEqual(mine[2], ['', 'לחם & חמאה']);
  assert.deepEqual(mine[3], ['', '', '7']);
});

test('the sheet dimension gives the progress bar a total', async () => {
  const meta = {};
  await collect(readXlsxRows(new Blob([book(SHEET)]), meta));
  assert.equal(meta.totalRows, 3); // 4 rows in the sheet, one of them the header
});

test('a sheet without a dimension still reads, with no total', async () => {
  const meta = {};
  const rows = await collect(
    readXlsxRows(new Blob([book('<sheetData><row r="1"><c r="A1" t="s"><v>2</v></c></row></sheetData>')]), meta),
  );
  assert.deepEqual(rows, [['חלב']]);
  assert.equal(meta.totalRows, undefined);
});

test('csv: BOM, quoted commas and a tab-delimited file', async () => {
  const csv = '﻿ברקוד,שם\n7290000042435,"חלב 1 ל\', בקרטון"\n';
  assert.deepEqual(await collect(readCsvRows(new Blob([csv]))), [
    ['ברקוד', 'שם'],
    ['7290000042435', "חלב 1 ל', בקרטון"],
  ]);

  const tsv = 'ברקוד\tשם\n123\tלחם\n';
  assert.deepEqual(await collect(readCsvRows(new Blob([tsv]))), [['ברקוד', 'שם'], ['123', 'לחם']]);
});

test('csv: a Windows-1255 export is not mangled', async () => {
  // Hebrew Excel's historical default. Read as UTF-8 it becomes question marks and the header
  // match fails, which is exactly the failure lib/decodeText.js exists to prevent.
  const cp1255 = Buffer.from([0xe1, 0xf8, 0xf7, 0xe5, 0xe3, 0x2c, 0xf9, 0xed, 0x0a, 0x31, 0x2c, 0xe7, 0xec, 0xe1]);
  assert.deepEqual(await collect(readCsvRows(new Blob([cp1255]))), [['ברקוד', 'שם'], ['1', 'חלב']]);
});

test('readCatalogRows picks the reader from the bytes, not the name', async () => {
  assert.deepEqual(await collect(readCatalogRows(new Blob([book(SHEET)]))), readXlsx(book(SHEET)));
  assert.deepEqual(await collect(readCatalogRows(new Blob(['ברקוד,שם\n1,חלב']))), [['ברקוד', 'שם'], ['1', 'חלב']]);
});

/** Stand in for the two server routes, recording what the client actually sent. */
function fakeServer({ keep }) {
  const calls = { prepare: [], batches: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (String(url).endsWith('/prepare')) {
      calls.prepare.push(body);
      return new Response(JSON.stringify({ keep }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    calls.batches.push(body);
    return new Response(
      JSON.stringify({ rows: body.rows.length, kept: body.rows.length, inserted: body.rows.length, updated: 0, unchanged: 0, repaired: 0, noBarcode: 0, badBarcode: 0, duplicate: 0 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('uploadCatalog narrows the columns, batches the rows and sums the totals', async () => {
  // 4,500 data rows over a 2,000-row batch size ⇒ three requests, none of them near the 4.5MB
  // body limit that made this whole path necessary.
  const lines = ['ברקוד,שם,מחיר מדף מינ׳'];
  for (let i = 0; i < 4500; i++) lines.push(`729000000${String(i).padStart(4, '0')},מוצר ${i},9.9`);
  const file = new Blob([lines.join('\n')]);

  const server = fakeServer({ keep: [0, 1] }); // the third column is one the server ignores
  const progress = [];
  try {
    const totals = await uploadCatalog(file, 'קטלוג בדיקה', (p) => progress.push(p.rows));
    assert.equal(server.calls.prepare.length, 1);
    assert.deepEqual(server.calls.prepare[0].header, ['ברקוד', 'שם', 'מחיר מדף מינ׳']);
    assert.equal(server.calls.batches.length, 3);
    assert.deepEqual(server.calls.batches.map((b) => b.rows.length), [2000, 2000, 500]);
    assert.deepEqual(server.calls.batches[0].header, ['ברקוד', 'שם']); // the ignored column is dropped
    assert.deepEqual(server.calls.batches[0].rows[0], ['7290000000000', 'מוצר 0']);
    assert.equal(server.calls.batches[0].source, 'קטלוג בדיקה');
    assert.equal(totals.inserted, 4500);
    assert.deepEqual(progress, [2000, 4000, 4500]);
  } finally {
    server.restore();
  }
});

test('uploadCatalog stops on a 4xx and says what the server said', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'חסרה עמודת ברקוד' }), { status: 400 });
  try {
    await assert.rejects(uploadCatalog(new Blob(['a,b\n1,2']), '', () => {}), /חסרה עמודת ברקוד/);
  } finally {
    globalThis.fetch = original;
  }
});

test('uploadCatalog retries a 500 and then gives up', async () => {
  const original = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/prepare')) {
      return new Response(JSON.stringify({ keep: [0, 1] }), { status: 200 });
    }
    attempts++;
    return new Response(JSON.stringify({ error: 'נפילה זמנית' }), { status: 500 });
  };
  try {
    await assert.rejects(uploadCatalog(new Blob(['ברקוד,שם\n1,חלב']), '', () => {}), /נפילה זמנית/);
    assert.equal(attempts, 4); // the first try plus three retries
  } finally {
    globalThis.fetch = original;
  }
});

test('summaryText reports repairs and skips, and stays quiet when there are none', () => {
  const clean = summaryText({ inserted: 5, updated: 2, unchanged: 1, repaired: 0, noBarcode: 0, badBarcode: 0, duplicate: 0 });
  assert.equal(clean, 'הקטלוג עודכן — נוספו 5, עודכנו 2, ללא שינוי 1.');
  const messy = summaryText({ inserted: 5, updated: 0, unchanged: 0, repaired: 3, noBarcode: 1, badBarcode: 2, duplicate: 0 });
  assert.match(messy, /3 ברקודים/);
  assert.match(messy, /דולגו 3 שורות/);
});
