import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readXlsx, looksLikeXlsx } from '../src/lib/xlsxRead.js';
import { makeXlsx, book } from './fixtures/xlsx.js';

test('looksLikeXlsx recognises the zip magic', () => {
  assert.equal(looksLikeXlsx(book('<sheetData/>')), true);
  assert.equal(looksLikeXlsx(Buffer.from('ברקוד,שם\n123,חלב')), false);
  assert.equal(looksLikeXlsx(Buffer.alloc(0)), false);
});

test('reads shared strings, numbers and inline strings', () => {
  const rows = readXlsx(
    book(
      '<sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>5.5</v></c></row>' +
        '<row r="3"><c r="A3" t="inlineStr"><is><t>מזומן</t></is></c></row>' +
        '</sheetData>',
    ),
  );
  assert.deepEqual(rows[0], ['ברקוד', 'שם']);
  assert.deepEqual(rows[1], ['חלב', '5.5']);
  assert.deepEqual(rows[2], ['מזומן']);
});

test('a blank leading cell does not shift the row', () => {
  // This is the case that made positional mapping wrong: xlsx omits empty cells, and a
  // self-closing <c .../> must still occupy its column. 1,896 rows of a real upload look
  // like this, and without the fix every value on them lands one column to the left.
  const rows = readXlsx(
    book(
      '<sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" s="4"/><c r="B2" t="s"><v>2</v></c></row>' +
        '<row r="3"><c r="C3"><v>7</v></c></row>' +
        '</sheetData>',
    ),
  );
  assert.deepEqual(rows[1], ['', 'חלב']);
  assert.deepEqual(rows[2], ['', '', '7']); // a cell that starts at column C keeps its place
});

test('follows the workbook to the first sheet, whatever the part is called', () => {
  // The part name follows creation order, not tab order — here the only sheet is sheet7.xml.
  const rows = readXlsx(book('<sheetData><row r="1"><c r="A1" t="s"><v>3</v></c></row></sheetData>'));
  assert.deepEqual(rows[0], ['לחם & חמאה']); // and entities are decoded
});

test('a file that is not a workbook yields no rows instead of throwing', () => {
  assert.deepEqual(readXlsx(Buffer.from('not a zip at all')), []);
  assert.deepEqual(readXlsx(makeXlsx({ 'docProps/core.xml': '<x/>' })), []);
});
