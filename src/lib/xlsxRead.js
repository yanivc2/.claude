// Read an .xlsx workbook's first sheet into rows of strings. Pure, no dependency.
//
// An .xlsx is a zip of XML parts, so node:zlib is all it takes: walk the central directory,
// inflate the two parts we need (`sharedStrings.xml` and the first worksheet), and scan them.
// Same hand-rolled spirit as lib/priceXml.js and lib/pdfPages.js — pulling in a spreadsheet
// library to read nine columns is not a trade worth making.
//
// Two details are load-bearing, both found by running this against a real 82,371-row upload
// rather than by reasoning about the format:
//
//   1. **Cells carry their address (`r="B3"`) and empty cells are OMITTED.** A row whose first
//      column is blank starts at `<c r="B3">`. Mapping cells by position would silently shift
//      every value one column left for exactly those rows — on the owner's file, 1,896 of them.
//   2. **Empty cells are self-closing** (`<c r="A3" s="4"/>`), so a greedy attribute capture
//      swallows the `/` and the cell never matches at all.
//
// Cost on that file: ~0.8s and ~95MB of heap, which is comfortable inside a serverless function.

import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
/** The zip end-of-central-directory record is within 64KB of the end (comment field max). */
const EOCD_SEARCH = 66000;

/** Map a cell reference's column letters to a zero-based index: A→0, B→1, AA→26. */
function columnIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Decode the five XML entities a spreadsheet writer can emit. */
function unescapeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * Index a zip's entries by name from its central directory.
 * @returns {Map<string, {method:number, size:number, offset:number}>}
 */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - EOCD_SEARCH; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  const entries = new Map();
  if (eocd < 0) return entries;

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && off + 46 <= buf.length; n++) {
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    entries.set(buf.toString('utf8', off + 46, off + 46 + nameLen), {
      method: buf.readUInt16LE(off + 10),
      size: buf.readUInt32LE(off + 20),
      offset: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate one zip entry to a Buffer, or null when it is absent or uses an unknown method. */
function readEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) return null;
  // The local header repeats the name/extra lengths, and they can differ from the central ones.
  const nameLen = buf.readUInt16LE(e.offset + 26);
  const extraLen = buf.readUInt16LE(e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.size);
  if (e.method === 0) return raw; // stored
  if (e.method === 8) return zlib.inflateRawSync(raw); // deflate
  return null;
}

/** True when the buffer starts with the zip magic — i.e. it is an xlsx and not a CSV. */
export function looksLikeXlsx(buf) {
  return Boolean(buf && buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50);
}

/**
 * Rows of the workbook's first worksheet, each an array of cell strings.
 * Missing cells come back as '' so a row's indexes always line up with the header's.
 *
 * @param {Buffer} buf the .xlsx bytes
 * @returns {string[][]} rows in sheet order, header included
 */
export function readXlsx(buf) {
  const entries = zipEntries(buf);
  if (entries.size === 0) return [];

  // Shared strings are optional — a sheet can hold every value inline.
  const shared = [];
  const ssBuf = readEntry(buf, entries, 'xl/sharedStrings.xml');
  if (ssBuf) {
    for (const si of ssBuf.toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // A single <si> can hold several <t> runs when the cell has mixed formatting.
      const runs = [...si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unescapeXml(t[1]));
      shared.push(runs.join(''));
    }
  }

  // Resolve the first sheet through the workbook rather than assuming 'sheet1.xml' — the part
  // name follows creation order, not tab order, and need not be sheet1 at all.
  const wb = readEntry(buf, entries, 'xl/workbook.xml');
  const rels = readEntry(buf, entries, 'xl/_rels/workbook.xml.rels');
  let sheetPath = 'xl/worksheets/sheet1.xml';
  if (wb && rels) {
    const first = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb.toString('utf8'));
    if (first) {
      const rel = new RegExp(`Id="${first[1]}"[^>]*Target="([^"]+)"`).exec(rels.toString('utf8'));
      if (rel) sheetPath = 'xl/' + rel[1].replace(/^\/?xl\//, '').replace(/^\//, '');
    }
  }
  const sheetBuf = readEntry(buf, entries, sheetPath) || readEntry(buf, entries, 'xl/worksheets/sheet1.xml');
  if (!sheetBuf) return [];

  const rows = [];
  for (const row of sheetBuf.toString('utf8').matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    // `([^>]*?)` must stay lazy: a self-closing empty cell ends in `/>`, and a greedy capture
    // eats the slash so the alternation never matches.
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] || '';
      const inner = c[2] || '';
      const ref = /r="([A-Z]+)/.exec(attrs);
      if (!ref) continue;
      const type = /t="([^"]+)"/.exec(attrs);
      let value = '';
      if (type && type[1] === 'inlineStr') {
        const t = /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner);
        value = t ? unescapeXml(t[1]) : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (v) value = type && type[1] === 's' ? (shared[Number(v[1])] ?? '') : unescapeXml(v[1]);
      }
      cells[columnIndex(ref[1])] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}
