import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readXlsx, looksLikeXlsx } from '../src/lib/xlsxRead.js';

/**
 * Build a real .xlsx in memory. Entries are DEFLATE-compressed, exactly as a spreadsheet writes
 * them, so the test exercises the same path a real upload does.
 */
function makeXlsx(parts) {
  const files = Object.entries(parts).map(([name, content]) => {
    const raw = Buffer.from(content, 'utf8');
    const deflated = zlib.deflateRawSync(raw);
    return { name: Buffer.from(name, 'utf8'), raw, deflated };
  });

  const locals = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt32LE(f.deflated.length, 18);
    lh.writeUInt32LE(f.raw.length, 22);
    lh.writeUInt16LE(f.name.length, 26);
    locals.push(lh, f.name, f.deflated);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(f.deflated.length, 20);
    ch.writeUInt32LE(f.raw.length, 24);
    ch.writeUInt16LE(f.name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, f.name);
    offset += 30 + f.name.length + f.deflated.length;
  }

  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const WORKBOOK = '<workbook><sheets><sheet name="קטלוג" sheetId="1" r:id="rId1"/></sheets></workbook>';
const RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet7.xml"/></Relationships>';
const SHARED = '<sst><si><t>ברקוד</t></si><si><t>שם</t></si><si><t>חלב</t></si><si><t>לחם &amp; חמאה</t></si></sst>';

function book(sheetXml, over = {}) {
  return makeXlsx({
    'xl/workbook.xml': WORKBOOK,
    'xl/_rels/workbook.xml.rels': RELS,
    'xl/sharedStrings.xml': SHARED,
    'xl/worksheets/sheet7.xml': sheetXml,
    ...over,
  });
}

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
