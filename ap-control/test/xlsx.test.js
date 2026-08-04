import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { parseXlsx } from '../src/lib/xlsx.js';
import { normalizeBankRows } from '../src/lib/bankCsv.js';
import { toAgorot } from '../src/lib/money.js';

// Build a minimal but real .xlsx (ZIP of XML parts, DEFLATE-compressed) so the test
// exercises the full path: ZIP central-directory read -> inflate -> XML -> rows.
function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(content, 'utf8');
    const comp = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(8, 8); // method = DEFLATE
    local.writeUInt32LE(0, 14); // crc (parser ignores)
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); // central dir sig
    cen.writeUInt16LE(8, 10); // method
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42); // local header offset
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdStart = offset;
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

// Shared strings, in index order, mirroring a real Bank Hapoalim Excel export.
const SI = [
  'תנועות בחשבון', // 0 - title (row 3)
  'תאריך', // 1
  'הפעולה', // 2
  'אסמכתא', // 3
  'חובה', // 4
  'זכות', // 5
  "יתרה בש''ח", // 6
  'שיק', // 7
  '', // 8 - empty credit cell
  'אמריקן אקספרס', // 9
];
const sharedStrings =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${SI.length}" uniqueCount="${SI.length}">` +
  SI.map((s) => (s === '' ? '<si><t/></si>' : `<si><t xml:space="preserve">${s}</t></si>`)).join('') +
  `</sst>`;

// Row 3: title. Row 5: header. Rows 6-7: data (dates as Excel serials, one debit + one credit).
// Balance on row 7 carries binary float drift, as Excel actually writes it.
const sheet =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
  `<row r="3"><c r="A3" t="s"><v>0</v></c></row>` +
  `<row r="5"><c r="A5" t="s"><v>1</v></c><c r="B5" t="s"><v>2</v></c><c r="C5" t="s"><v>3</v></c>` +
  `<c r="D5" t="s"><v>4</v></c><c r="E5" t="s"><v>5</v></c><c r="F5" t="s"><v>6</v></c></row>` +
  `<row r="6"><c r="A6"><v>46229</v></c><c r="B6" t="s"><v>7</v></c><c r="C6"><v>31505</v></c>` +
  `<c r="D6"><v>1911.66</v></c><c r="E6" t="s"><v>8</v></c><c r="F6"><v>-67905.82</v></c></row>` +
  `<row r="7"><c r="A7"><v>46237</v></c><c r="B7" t="s"><v>9</v></c><c r="C7"><v>26000281</v></c>` +
  `<c r="D7" t="s"><v>8</v></c><c r="E7"><v>46.16</v></c><c r="F7"><v>2231.9299999999998</v></c></row>` +
  `</sheetData></worksheet>`;

function fixture() {
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['xl/sharedStrings.xml', sharedStrings],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}

test('parseXlsx reads a Bank Hapoalim .xlsx: serial dates, חובה/זכות, description, balance', () => {
  const rows = normalizeBankRows(parseXlsx(fixture()));
  assert.equal(rows.length, 2);

  // Excel serial 46229 -> 2026-07-26; debit (חובה) -> negative; אסמכתא -> reference.
  assert.equal(rows[0].txnDate, '2026-07-26');
  assert.equal(rows[0].amount, -toAgorot('1911.66'));
  assert.equal(rows[0].rawReference, '31505');
  assert.equal(rows[0].description, 'שיק');
  assert.equal(rows[0].balanceAfter, -toAgorot('67905.82'));

  // Serial 46237 -> 2026-08-03; credit (זכות) -> positive.
  assert.equal(rows[1].txnDate, '2026-08-03');
  assert.equal(rows[1].amount, toAgorot('46.16'));
  assert.equal(rows[1].description, 'אמריקן אקספרס');
});

test('parseXlsx snaps Excel float drift (2231.9299999999998) back to 2 decimals', () => {
  const rows = normalizeBankRows(parseXlsx(fixture()));
  // Row 7 balance was written with binary drift; must land on exactly 2231.93.
  assert.equal(rows[1].balanceAfter, toAgorot('2231.93'));
});

test('parseXlsx throws a Hebrew error when no header row is present', () => {
  const bad = zip([
    ['xl/sharedStrings.xml', `<?xml version="1.0"?><sst><si><t>x</t></si></sst>`],
    ['xl/worksheets/sheet1.xml', `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`],
  ]);
  assert.throws(() => parseXlsx(bad), /Excel/);
});
