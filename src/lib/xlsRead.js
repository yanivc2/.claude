// Legacy .xls reader (OLE2 compound file + BIFF8) → a string[][] grid.
//
// The nightly "דוח פדיון" from the POS is produced by JasperReports as a **legacy .xls**: an OLE2
// container holding a BIFF8 "Workbook" stream. That is NOT the ZIP-based .xlsx that lib/xlsxRead.js
// handles, so it must be decoded separately. Hand-rolled (no dependency), mirroring the style of
// the existing xlsx reader: only the record types these reports actually emit are decoded.

const OLE_SIG = 'd0cf11e0a1b11ae1';
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;

/** True when the buffer is an OLE2 compound document (a legacy .xls). */
export function looksLikeXls(buf) {
  return Boolean(buf && buf.length > 8 && buf.subarray(0, 8).toString('hex') === OLE_SIG);
}

/** Read the OLE2 container and return its streams as a Map<name, Buffer>. */
function oleStreams(buf) {
  const secShift = buf.readUInt16LE(30);
  const miniShift = buf.readUInt16LE(32);
  const secSize = 1 << secShift;
  const miniSize = 1 << miniShift;
  const dirStart = buf.readUInt32LE(0x30);
  const miniFatStart = buf.readUInt32LE(0x3c);
  const difatStart = buf.readUInt32LE(0x44);
  const miniCutoff = buf.readUInt32LE(0x38) || 4096;
  const off = (s) => (s + 1) * secSize;

  // FAT sector list: the 109 header DIFAT entries, then any DIFAT chain sectors.
  const fatSectors = [];
  for (let i = 0; i < 109; i += 1) {
    const v = buf.readUInt32LE(0x4c + i * 4);
    if (v < FREESECT - 4) fatSectors.push(v);
  }
  let ds = difatStart;
  for (let guard = 0; ds < FREESECT - 4 && guard < 10000; guard += 1) {
    const base = off(ds);
    if (base + secSize > buf.length) break;
    for (let i = 0; i < secSize / 4 - 1; i += 1) {
      const v = buf.readUInt32LE(base + i * 4);
      if (v < FREESECT - 4) fatSectors.push(v);
    }
    ds = buf.readUInt32LE(base + secSize - 4);
  }
  const FAT = [];
  for (const fs of fatSectors) {
    const base = off(fs);
    if (base + secSize > buf.length) break;
    for (let i = 0; i < secSize / 4; i += 1) FAT.push(buf.readUInt32LE(base + i * 4));
  }

  const chainOf = (start, table) => {
    const out = [];
    let c = start;
    for (let guard = 0; c < FREESECT - 4 && guard < 1e6; guard += 1) {
      out.push(c);
      c = table[c];
      if (c === undefined || c === ENDOFCHAIN) break;
    }
    return out;
  };
  const readMain = (start, size) => {
    const parts = chainOf(start, FAT)
      .map((s) => buf.subarray(off(s), off(s) + secSize))
      .filter((b) => b.length);
    const all = Buffer.concat(parts);
    return size ? all.subarray(0, size) : all;
  };

  // Directory entries
  const dirBuf = readMain(dirStart);
  const entries = [];
  for (let i = 0; i + 128 <= dirBuf.length; i += 128) {
    const nameLen = dirBuf.readUInt16LE(i + 0x40);
    if (!nameLen) continue;
    const name = dirBuf.subarray(i, i + Math.max(0, nameLen - 2)).toString('utf16le');
    entries.push({ name, type: dirBuf.readUInt8(i + 0x42), start: dirBuf.readUInt32LE(i + 0x74), size: dirBuf.readUInt32LE(i + 0x78) });
  }

  // Mini stream (small streams live inside the root entry's stream, indexed by the mini FAT).
  const root = entries.find((e) => e.type === 5);
  const miniFat = [];
  if (miniFatStart < FREESECT - 4) {
    const mf = readMain(miniFatStart);
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
  }
  const miniStream = root && root.size ? readMain(root.start, root.size) : Buffer.alloc(0);
  const readMini = (start, size) => {
    const parts = chainOf(start, miniFat).map((s) => miniStream.subarray(s * miniSize, s * miniSize + miniSize));
    const all = Buffer.concat(parts);
    return size ? all.subarray(0, size) : all;
  };

  const out = new Map();
  for (const e of entries) {
    if (e.type !== 2) continue; // streams only
    out.set(e.name, e.size < miniCutoff ? readMini(e.start, e.size) : readMain(e.start, e.size));
  }
  return out;
}

/** Decode an RK number (BIFF's packed float). */
function rkNumber(rk) {
  const isX100 = rk & 1;
  const isInt = rk & 2;
  let v;
  if (isInt) {
    v = rk >> 2; // signed
  } else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(rk & 0xfffffffc, 4);
    v = b.readDoubleLE(0);
  }
  return isX100 ? v / 100 : v;
}

/** Shared-string table (SST + its CONTINUE records). */
function readSst(records, W) {
  const i = records.findIndex((r) => r.t === 0x00fc);
  if (i === -1) return [];
  const parts = [W.subarray(records[i].off, records[i].off + records[i].len)];
  for (let j = i + 1; j < records.length && records[j].t === 0x003c; j += 1) {
    parts.push(W.subarray(records[j].off, records[j].off + records[j].len));
  }
  const blob = Buffer.concat(parts);
  const out = [];
  let q = 8; // cstTotal, cstUnique
  while (q + 3 <= blob.length && out.length < 200000) {
    const cch = blob.readUInt16LE(q); q += 2;
    const flags = blob.readUInt8(q); q += 1;
    const high = flags & 1;
    const ext = flags & 4;
    const rich = flags & 8;
    let cRun = 0;
    let cbExt = 0;
    if (rich) { cRun = blob.readUInt16LE(q); q += 2; }
    if (ext) { cbExt = blob.readUInt32LE(q); q += 4; }
    let s;
    if (high) { s = blob.subarray(q, q + cch * 2).toString('utf16le'); q += cch * 2; }
    else { s = Buffer.from(blob.subarray(q, q + cch)).toString('latin1'); q += cch; }
    if (rich) q += cRun * 4;
    if (ext) q += cbExt;
    out.push(s);
  }
  return out;
}

/**
 * The first worksheet of a legacy .xls as string[][] — missing cells come back as '' so a row's
 * indexes line up. Values are returned as their displayed text (these reports store money as text).
 * @param {Buffer} buf
 * @returns {string[][]}
 */
export function readXls(buf) {
  const streams = oleStreams(buf);
  const W = streams.get('Workbook') || streams.get('Book');
  if (!W) return [];

  const records = [];
  for (let p = 0; p + 4 <= W.length;) {
    const t = W.readUInt16LE(p);
    const len = W.readUInt16LE(p + 2);
    records.push({ t, len, off: p + 4 });
    p += 4 + len;
  }
  const sst = readSst(records, W);

  const cells = new Map(); // row -> Map(col -> value)
  const put = (r, c, v) => {
    if (!cells.has(r)) cells.set(r, new Map());
    cells.get(r).set(c, v);
  };
  for (const r of records) {
    const d = W.subarray(r.off, r.off + r.len);
    try {
      if (r.t === 0x00fd) put(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? ''); // LABELSST
      else if (r.t === 0x0203) put(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6)); // NUMBER
      else if (r.t === 0x027e) put(d.readUInt16LE(0), d.readUInt16LE(2), rkNumber(d.readUInt32LE(6))); // RK
      else if (r.t === 0x00bd) { // MULRK
        const row = d.readUInt16LE(0);
        let col = d.readUInt16LE(2);
        for (let k = 4; k + 6 <= r.len; k += 6, col += 1) put(row, col, rkNumber(d.readUInt32LE(k + 2)));
      } else if (r.t === 0x0204) { // LABEL
        const cch = d.readUInt16LE(6);
        const high = d.readUInt8(8) & 1;
        const s = high ? d.subarray(9, 9 + cch * 2).toString('utf16le') : Buffer.from(d.subarray(9, 9 + cch)).toString('latin1');
        put(d.readUInt16LE(0), d.readUInt16LE(2), s);
      }
    } catch { /* skip a malformed record rather than losing the sheet */ }
  }
  if (!cells.size) return [];

  const maxRow = Math.max(...cells.keys());
  const grid = [];
  for (let r = 0; r <= maxRow; r += 1) {
    const row = cells.get(r);
    if (!row) { grid.push([]); continue; }
    const maxCol = Math.max(...row.keys());
    const arr = new Array(maxCol + 1).fill('');
    for (const [c, v] of row) arr[c] = v === null || v === undefined ? '' : String(v);
    grid.push(arr);
  }
  return grid;
}
