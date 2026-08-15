// טעינת קטלוג-על: קריאת הקובץ בדפדפן ושליחתו לשרת במנות.
//
// Why this exists at all: Vercel rejects a request body over ~4.5MB at the platform edge, before
// Express ever runs — the owner's four-chain workbook is 5.8MB and came back as a bare
// `413 FUNCTION_PAYLOAD_TOO_LARGE` page with nothing in the app logs. The parser was never the
// problem; the transport was. So the file's bulk never leaves the browser: this module reads it
// here and POSTs ~2,000 rows at a time, an order of magnitude under the cap.
//
// It is written to be read in one pass and to stay honest about memory, because the owner may
// well do this from a phone:
//
//   • The zip is read through `Blob.slice()` — the end-of-central-directory record lives in the
//     last 64KB, and each entry is its own slice. The 5.8MB file is never held whole.
//   • The worksheet is *streamed* through `DecompressionStream('deflate-raw')` and cut at every
//     `</row>`, so the ~50MB of inflated XML is never held either. Rows are emitted, batched,
//     sent, and freed. Peak memory ≈ the shared strings + one batch.
//
// **The XLSX reading here is a deliberate twin of `src/lib/xlsxRead.js`** — same cell regex, same
// two load-bearing rules (map cells by the `r="B3"` column letter and never by position, because
// empty cells are omitted entirely; keep the attribute capture lazy, because an empty cell is
// self-closing and a greedy capture eats the `/`). `test/catalog-upload.test.js` feeds both
// readers the same workbook and asserts they agree, which is what keeps the twins from drifting.
//
// No business logic lives here. Header aliases, the leading-zero barcode repair and the
// median-of-four-chains price all stay on the server in `src/lib/catalogFile.js`, in one place.

/** Rows per request. ~2,000 rows of this catalog is ~400KB of JSON. */
const BATCH_ROWS = 2000;
/** …unless the rows are wide: flush early once a batch reaches this many characters. */
const BATCH_CHARS = 1200000;
/** Network hiccups are retried; a 4xx is a real answer and is not. */
const BATCH_RETRIES = 3;
/** What a browser without DecompressionStream can still push through the old form path. */
const FALLBACK_MAX_BYTES = 4 * 1024 * 1024;

const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_EOCD_SIG = 0x06054b50;
/** The end-of-central-directory record is within 64KB of the end (its comment field's max). */
const EOCD_SEARCH = 66000;

/* ─────────────────────────── zip ─────────────────────────── */

const u16 = (dv, o) => dv.getUint16(o, true);
const u32 = (dv, o) => dv.getUint32(o, true);

async function view(blob, start, end) {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

/** Index the zip's entries by name from its central directory. Null when this is not a zip. */
async function zipEntries(blob) {
  const tailLen = Math.min(EOCD_SEARCH, blob.size);
  const tail = await view(blob, blob.size - tailLen, blob.size);
  let eocd = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (u32(tail, i) === ZIP_EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = u16(tail, eocd + 10);
  const cdSize = u32(tail, eocd + 12);
  const cdOffset = u32(tail, eocd + 16);
  const cd = await view(blob, cdOffset, cdOffset + cdSize);
  const decoder = new TextDecoder('utf-8');
  const entries = new Map();
  let off = 0;
  for (let n = 0; n < count && off + 46 <= cd.byteLength; n++) {
    const nameLen = u16(cd, off + 28);
    const extraLen = u16(cd, off + 30);
    const commentLen = u16(cd, off + 32);
    const name = decoder.decode(new Uint8Array(cd.buffer, cd.byteOffset + off + 46, nameLen));
    entries.set(name, { method: u16(cd, off + 10), size: u32(cd, off + 20), offset: u32(cd, off + 42) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** A byte stream for one zip entry, inflated when needed. Null for an unknown method. */
async function entryStream(blob, entry) {
  if (!entry) return null;
  // The local header repeats the name/extra lengths and they can differ from the central ones.
  const head = await view(blob, entry.offset, entry.offset + 30);
  const start = entry.offset + 30 + u16(head, 26) + u16(head, 28);
  const raw = blob.slice(start, start + entry.size).stream();
  if (entry.method === 0) return raw; // stored
  if (entry.method === 8) return raw.pipeThrough(new DecompressionStream('deflate-raw'));
  return null;
}

/* ────────────────────────── streams ────────────────────────── */

/**
 * Decoded text, chunk by chunk. Uses an explicit reader loop rather than `for await` over the
 * stream: Safari does not put an async iterator on ReadableStream.
 */
async function* textChunks(stream, encoding) {
  const reader = stream.pipeThrough(new TextDecoderStream(encoding || 'utf-8')).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** Cut a text stream on a delimiter, yielding the piece before each one (and any tail). */
async function* splitOn(chunks, delimiter) {
  let buf = '';
  for await (const chunk of chunks) {
    buf += chunk;
    let pos = 0;
    let i;
    while ((i = buf.indexOf(delimiter, pos)) !== -1) {
      yield buf.slice(pos, i);
      pos = i + delimiter.length;
    }
    if (pos) buf = buf.slice(pos);
  }
  if (buf) yield buf;
}

/** Whole (small) entry as one string — workbook.xml and its rels. */
async function readAll(blob, entries, name) {
  const stream = await entryStream(blob, entries.get(name));
  if (!stream) return null;
  let out = '';
  for await (const chunk of textChunks(stream)) out += chunk;
  return out;
}

/* ──────────────────────────── xlsx ──────────────────────────── */

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

async function sharedStringsOf(blob, entries) {
  const stream = await entryStream(blob, entries.get('xl/sharedStrings.xml'));
  const out = [];
  if (!stream) return out; // optional — a sheet can hold every value inline
  for await (const si of splitOn(textChunks(stream), '</si>')) {
    if (si.indexOf('<si') === -1) continue; // the tail after the last </si> is not a string
    // One <si> can hold several <t> runs when the cell has mixed formatting.
    let text = '';
    for (const t of si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += unescapeXml(t[1]);
    out.push(text);
  }
  return out;
}

/** The first sheet's part name — resolved through the workbook, since it need not be sheet1. */
async function firstSheetPath(blob, entries) {
  const wb = await readAll(blob, entries, 'xl/workbook.xml');
  const rels = await readAll(blob, entries, 'xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = /<sheet\b[^>]*r:id="([^"]+)"/.exec(wb);
    if (first) {
      const rel = new RegExp(`Id="${first[1]}"[^>]*Target="([^"]+)"`).exec(rels);
      if (rel) return 'xl/' + rel[1].replace(/^\/?xl\//, '').replace(/^\//, '');
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/** One `</row>`-delimited fragment → its cells, placed by column letter. */
function cellsOf(fragment, shared) {
  const cells = [];
  // `([^>]*?)` must stay lazy: an empty cell ends in `/>`, and a greedy capture eats the slash so
  // the alternation never matches.
  for (const c of fragment.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
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
  return cells;
}

/**
 * Rows of the workbook's first worksheet, streamed.
 * @param {Blob} blob the .xlsx
 * @param {{totalRows?: number}} [meta] filled with the sheet's declared row count when it has one
 */
export async function* readXlsxRows(blob, meta) {
  const entries = await zipEntries(blob);
  if (!entries) throw new Error('הקובץ אינו XLSX תקין.');
  const shared = await sharedStringsOf(blob, entries);
  const path = await firstSheetPath(blob, entries);
  const stream = (await entryStream(blob, entries.get(path)))
    || (await entryStream(blob, entries.get('xl/worksheets/sheet1.xml')));
  if (!stream) throw new Error('לא נמצא גיליון בקובץ.');

  let first = true;
  for await (const fragment of splitOn(textChunks(stream), '</row>')) {
    if (first) {
      first = false;
      // Excel writes <dimension ref="A1:L82372"/> ahead of the rows, which is the only cheap way
      // to show a real "X out of Y" while streaming. Absent, the progress line just counts up.
      const dim = /<dimension[^>]*ref="[A-Z]+\d+:[A-Z]+(\d+)"/.exec(fragment);
      if (dim && meta) meta.totalRows = Math.max(0, Number(dim[1]) - 1);
    }
    if (fragment.indexOf('<row') === -1) continue; // trailing </sheetData> etc.
    yield cellsOf(fragment, shared);
  }
}

/* ───────────────────────────── csv ───────────────────────────── */

/**
 * Split one delimited line, honouring RFC-4180 quoting — the same rules as `lib/catalogFile.js`,
 * because Hebrew product names contain both commas and doubled quotes.
 */
function splitLine(line, delimiter) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/**
 * Pick the encoding the way `lib/decodeText.js` does: a BOM decides, otherwise strict UTF-8 with
 * a Windows-1255 fallback (Hebrew Excel's historical default, whose high bytes are not valid
 * UTF-8). TextDecoderStream strips a BOM itself, so this only has to choose.
 */
async function sniffEncoding(blob) {
  const head = new Uint8Array(await blob.slice(0, Math.min(65536, blob.size)).arrayBuffer());
  if (head[0] === 0xff && head[1] === 0xfe) return 'utf-16le';
  if (head[0] === 0xfe && head[1] === 0xff) return 'utf-16be';
  try {
    // `stream: true` holds back a truncated trailing sequence, so only genuinely invalid bytes throw.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return 'utf-8';
  } catch {
    return 'windows-1255';
  }
}

/** Rows of a delimited text file, streamed. */
export async function* readCsvRows(blob) {
  const encoding = await sniffEncoding(blob);
  let delimiter = null;
  for await (const raw of splitOn(textChunks(blob.stream(), encoding), '\n')) {
    const line = raw.replace(/\r$/, '').replace(/^﻿/, '');
    if (line.trim() === '') continue;
    // Comma or tab, whichever appears more often in the header line.
    if (delimiter === null) {
      delimiter = (line.match(/\t/g) || []).length > (line.match(/,/g) || []).length ? '\t' : ',';
    }
    yield splitLine(line, delimiter);
  }
}

/** Rows of a catalog file, xlsx or delimited text — decided by the bytes, not the extension. */
export async function* readCatalogRows(blob, meta) {
  const head = await view(blob, 0, Math.min(4, blob.size));
  const isZip = head.byteLength >= 4 && u32(head, 0) === ZIP_LOCAL_SIG;
  yield* isZip ? readXlsxRows(blob, meta) : readCsvRows(blob);
}

/** True when this browser can read a catalog file itself. */
export function canReadLocally() {
  return typeof DecompressionStream !== 'undefined'
    && typeof TextDecoderStream !== 'undefined'
    && typeof Blob !== 'undefined'
    && typeof Blob.prototype.stream === 'function';
}

/* ──────────────────────────── upload ──────────────────────────── */

async function postJson(url, body, retries = 0) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 800 * attempt));
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = new Error('הרשת נותקה באמצע הטעינה.');
      continue; // a dropped connection is worth another try
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data;
    // A 4xx is an answer, not a hiccup — stop and show what the server said.
    if (res.status < 500) throw new Error(data.error || `השרת החזיר שגיאה (${res.status}).`);
    lastErr = new Error(data.error || `השרת החזיר שגיאה (${res.status}).`);
  }
  throw lastErr || new Error('הטעינה נכשלה.');
}

/**
 * Read `file` and import it batch by batch.
 * @param {File} file
 * @param {string} source the source name recorded on every row
 * @param {(p: {rows:number, total:number|null}) => void} onProgress
 * @returns {Promise<object>} summed stats
 */
export async function uploadCatalog(file, source, onProgress) {
  const meta = {};
  const totals = { rows: 0, kept: 0, repaired: 0, noBarcode: 0, badBarcode: 0, duplicate: 0, inserted: 0, updated: 0, unchanged: 0 };
  let header = null;
  let keep = null;
  let batch = [];
  let chars = 0;
  let sent = 0;

  const flush = async () => {
    if (!batch.length) return;
    const result = await postJson('/settings/catalog-import/batch', { header, rows: batch, source }, BATCH_RETRIES);
    for (const k of Object.keys(totals)) totals[k] += Number(result[k] || 0);
    sent += batch.length;
    batch = [];
    chars = 0;
    onProgress({ rows: sent, total: meta.totalRows ?? null });
  };

  for await (const row of readCatalogRows(file, meta)) {
    if (!header) {
      // Ask the server which columns are worth sending — and let it reject a bad header (or a
      // database that still needs "עדכון מסד נתונים") before the owner waits through the file.
      const prep = await postJson('/settings/catalog-import/prepare', { header: row });
      keep = prep.keep;
      header = keep.map((i) => row[i] ?? '');
      continue;
    }
    const slim = keep.map((i) => row[i] ?? '');
    batch.push(slim);
    for (const cell of slim) chars += cell.length;
    if (batch.length >= BATCH_ROWS || chars >= BATCH_CHARS) await flush();
  }
  if (!header) throw new Error('הקובץ ריק.');
  await flush();
  return totals;
}

/** The same Hebrew sentence the server-side single-shot import reports. */
export function summaryText(t) {
  const parts = [`הקטלוג עודכן — נוספו ${t.inserted}, עודכנו ${t.updated}, ללא שינוי ${t.unchanged}.`];
  if (t.repaired) {
    parts.push(`⚠ ${t.repaired} ברקודים הגיעו בלי אפסים מובילים (סימן שהקובץ נערך באקסל) ותוקנו לפי ספרת הביקורת.`);
  }
  const dropped = t.noBarcode + t.badBarcode + t.duplicate;
  if (dropped) {
    parts.push(`דולגו ${dropped} שורות: ${t.noBarcode} בלי ברקוד או שם, ${t.badBarcode} ברקוד לא תקין, ${t.duplicate} כפולות.`);
  }
  return parts.join(' ');
}

/* ───────────────────────────── wiring ───────────────────────────── */

function init() {
  const form = document.querySelector('#dlg-catalog form');
  if (!form) return;
  const status = document.getElementById('catalog-status');
  const progress = document.getElementById('catalog-progress');
  const bar = document.getElementById('catalog-bar');
  if (!status || !progress || !bar) return; // markup and script must ship together

  const say = (text) => { progress.hidden = false; status.textContent = text; };

  form.addEventListener('submit', async (ev) => {
    const file = form.catalog && form.catalog.files && form.catalog.files[0];
    if (!file) return; // let the browser's own `required` validation speak

    // Without DecompressionStream we cannot read the file here, and anything over ~4.5MB is
    // refused by Vercel before Express runs. Say that plainly instead of letting the owner
    // watch an upload finish and then land on a bare English 413 page.
    if (!canReadLocally()) {
      if (file.size > FALLBACK_MAX_BYTES) {
        ev.preventDefault();
        say('הדפדפן הזה לא יודע לקרוא קובץ גדול, והשרת מוגבל ל-4.5MB. נסה מדפדפן עדכני (Chrome/Safari) או מהמחשב.');
      }
      return; // small file: the ordinary form POST still works
    }

    ev.preventDefault();
    const buttons = form.querySelectorAll('button, input');
    buttons.forEach((b) => { b.disabled = true; });
    bar.style.width = '0%';
    bar.parentElement.hidden = false;
    say('קורא את הקובץ…');

    try {
      const totals = await uploadCatalog(file, (form.source_name && form.source_name.value.trim()) || '', (p) => {
        if (p.total) {
          bar.style.width = Math.min(100, Math.round((p.rows / p.total) * 100)) + '%';
          say(`נטענו ${p.rows.toLocaleString('he-IL')} מתוך ${p.total.toLocaleString('he-IL')} שורות…`);
        } else {
          say(`נטענו ${p.rows.toLocaleString('he-IL')} שורות…`);
        }
      });
      bar.style.width = '100%';
      bar.parentElement.hidden = true;
      say(summaryText(totals));
    } catch (err) {
      bar.parentElement.hidden = true;
      // The import is an upsert, so re-running the same file is always safe — say so, because
      // otherwise a half-finished import looks like something that has to be undone first.
      say(`הטעינה נעצרה: ${err.message} אפשר לטעון את הקובץ שוב — הטעינה מצטברת ולא מוחקת דבר.`);
    } finally {
      buttons.forEach((b) => { b.disabled = false; });
    }
  });
}

if (typeof document !== 'undefined') init();
