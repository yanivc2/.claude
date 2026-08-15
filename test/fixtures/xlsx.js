// Build a real .xlsx in memory. Entries are DEFLATE-compressed, exactly as a spreadsheet writes
// them, so a test exercises the same path a real upload does.
//
// Shared by test/xlsx-read.test.js (the server reader) and test/catalog-upload.test.js (the
// browser reader) — feeding both the identical bytes is what proves the two stay in step.
import zlib from 'node:zlib';

export function makeXlsx(parts) {
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

export const WORKBOOK = '<workbook><sheets><sheet name="קטלוג" sheetId="1" r:id="rId1"/></sheets></workbook>';
export const RELS = '<Relationships><Relationship Id="rId1" Target="worksheets/sheet7.xml"/></Relationships>';
export const SHARED = '<sst><si><t>ברקוד</t></si><si><t>שם</t></si><si><t>חלב</t></si><si><t>לחם &amp; חמאה</t></si></sst>';

/** A workbook whose only sheet is the deliberately-not-sheet1 part name. */
export function book(sheetXml, over = {}) {
  return makeXlsx({
    'xl/workbook.xml': WORKBOOK,
    'xl/_rels/workbook.xml.rels': RELS,
    'xl/sharedStrings.xml': SHARED,
    'xl/worksheets/sheet7.xml': sheetXml,
    ...over,
  });
}
