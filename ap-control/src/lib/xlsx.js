// Minimal, dependency-free .xlsx reader — enough to import a bank statement the
// secretary saved as Excel (Bank Hapoalim "תנועות בחשבון" exports, in particular).
//
// An .xlsx is a ZIP of XML parts. We read three parts with Node's built-in zlib
// (no third-party ZIP/spreadsheet library): the shared-strings table and the
// worksheet cells, then flatten cells into the same row-object shape parseCsv()
// produces so normalizeBankRows() can consume either source unchanged.
//
// Deliberately narrow: single-region ZIPs (no ZIP64, no encryption), the
// STORE (0) and DEFLATE (8) compression methods, and the cell types a bank
// export actually emits (shared string, inline string, plain number). Anything
// outside that throws a Hebrew error the route surfaces to the user.

import { inflateRawSync } from 'node:zlib';

// ---- ZIP -------------------------------------------------------------------

const EOCD_SIG = 0x06054b50; // End Of Central Directory
const CEN_SIG = 0x02014b50; // Central directory file header
const LOC_SIG = 0x04034b50; // Local file header

/** Read the central directory and return a Map<name, Buffer> of decompressed entries. */
function unzip(buf) {
  const files = new Map();
  // Find EOCD by scanning backwards (comment is usually empty, so it is near the end).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('קובץ Excel לא תקין (חסר EOCD).');

  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset

  for (let n = 0; n < total; n += 1) {
    if (buf.readUInt32LE(ptr) !== CEN_SIG) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // Jump to the local header to locate the data (its name/extra lengths can differ).
    if (buf.readUInt32LE(localOff) === LOC_SIG) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      let content;
      if (method === 0) content = Buffer.from(raw);
      else if (method === 8) content = inflateRawSync(raw);
      else throw new Error(`שיטת דחיסה לא נתמכת ב-Excel (${method}).`);
      files.set(name, content);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---- XML helpers -----------------------------------------------------------

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&'); // last, so &amp;lt; survives correctly
}

/** All <t>…</t> text inside a fragment, concatenated (handles rich-text <r><t> runs). */
function collectText(fragment) {
  let out = '';
  const re = /<t\b[^>]*?(\/>|>([\s\S]*?)<\/t>)/g;
  let m;
  while ((m = re.exec(fragment))) {
    if (m[1] !== '/>') out += m[2];
  }
  return unescapeXml(out);
}

/** Parse xl/sharedStrings.xml into an array of plain strings. */
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) out.push(m[1] != null ? collectText(m[1]) : '');
  return out;
}

/** 'A' -> 0, 'B' -> 1, 'AA' -> 26 … (letters of a cell ref, ignoring the row digits). */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break; // stop at the first digit
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

// ---- Excel serial date -----------------------------------------------------

/** Excel serial day number -> 'YYYY-MM-DD' (1900 date system, incl. the 1900 leap-year quirk). */
function serialToIso(serial) {
  const n = Math.floor(Number(serial));
  if (!Number.isFinite(n) || n <= 0) return null;
  // Excel day 1 = 1900-01-01; day 60 is the fictional 1900-02-29. Base 1899-12-30
  // makes both sides line up for every real date after 1900-03-01.
  const ms = Date.UTC(1899, 11, 30) + n * 86400000;
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// ---- Worksheet -------------------------------------------------------------

const DATE_HEADER_HINTS = ['תאריך', 'תאריך ערך', 'date', 'value date'];
const HEADER_HINTS = [
  'תאריך', 'חובה', 'זכות', 'סכום', 'אסמכתא', 'תיאור', 'פרטים', 'יתרה', 'הפעולה',
  'date', 'amount', 'debit', 'credit', 'description', 'reference', 'balance',
];

/** Parse one worksheet XML into an array of {colIndex: rawString} row maps. */
function parseSheetRows(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = {};
    const cellRe = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1];
      const body = cm[2] === '/>' ? '' : cm[3];
      const refM = /\br="([A-Z]+)\d+"/.exec(attrs);
      if (!refM) continue;
      const ci = colIndex(refM[1]);
      const typeM = /\bt="([^"]+)"/.exec(attrs);
      const type = typeM ? typeM[1] : 'n';
      let value = '';
      if (type === 's') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? shared[Number(vM[1])] ?? '' : '';
      } else if (type === 'inlineStr') {
        value = collectText(body);
      } else if (type === 'str') {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? unescapeXml(vM[1]) : '';
      } else {
        const vM = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = vM ? vM[1] : '';
      }
      cells[ci] = String(value).trim();
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Parse an .xlsx buffer into rows keyed by lowercased header — the exact shape
 * parseCsv() returns — so normalizeBankRows() consumes it with no changes.
 * The first row that looks like a bank header is used as the header row; earlier
 * title/metadata rows are skipped. Numeric cells under a date column are
 * converted from Excel serials to ISO dates.
 *
 * @param {Buffer|Uint8Array} buf
 * @returns {Array<Record<string,string>>}
 */
export function parseXlsx(buf) {
  const files = unzip(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  const shared = parseSharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));

  // Choose the first worksheet that actually contains a recognisable header row.
  const sheetNames = [...files.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort();
  if (sheetNames.length === 0) throw new Error('לא נמצא גיליון בקובץ ה-Excel.');

  for (const sheetName of sheetNames) {
    const rows = parseSheetRows(files.get(sheetName).toString('utf8'), shared);
    const maxCol = rows.reduce(
      (mx, r) => Object.keys(r).reduce((m, k) => Math.max(m, Number(k)), mx),
      -1,
    );
    const cellsAt = (r) => {
      const arr = [];
      for (let i = 0; i <= maxCol; i += 1) arr.push(r[i] ?? '');
      return arr;
    };
    const looksLikeHeader = (arr) => {
      const nonEmpty = arr.filter((c) => c.trim() !== '');
      return (
        nonEmpty.length >= 2 &&
        nonEmpty.some((c) => HEADER_HINTS.some((t) => c.toLowerCase().includes(t)))
      );
    };
    const headerIdx = rows.findIndex((r) => looksLikeHeader(cellsAt(r)));
    if (headerIdx < 0) continue;

    const headers = cellsAt(rows[headerIdx]).map((h) => h.trim().toLowerCase());
    const dateCols = new Set(
      headers.map((h, i) => (DATE_HEADER_HINTS.includes(h) ? i : -1)).filter((i) => i >= 0),
    );
    const out = [];
    for (let i = headerIdx + 1; i < rows.length; i += 1) {
      const arr = cellsAt(rows[i]);
      if (arr.every((c) => c.trim() === '')) continue; // blank row
      const obj = {};
      headers.forEach((h, idx) => {
        let v = arr[idx] ?? '';
        // Date columns hold Excel serials (e.g. 46237) — convert to ISO.
        if (dateCols.has(idx) && /^\d+(\.\d+)?$/.test(v)) v = serialToIso(v) || v;
        // Excel stores money as full-precision floats (2231.93 -> "2231.9299999999998").
        // Snap that binary drift back to 2 decimals so toAgorot accepts it; integers
        // (reference/asmachta numbers) keep their exact string.
        else if (/^-?\d+\.\d{3,}$/.test(v)) v = String(Math.round(parseFloat(v) * 100) / 100);
        obj[h] = v;
      });
      out.push(obj);
    }
    return out;
  }
  throw new Error('לא זוהתה שורת כותרת בקובץ ה-Excel (תאריך/חובה/זכות).');
}
