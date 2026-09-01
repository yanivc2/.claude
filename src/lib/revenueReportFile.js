import { readXlsx, looksLikeXlsx } from './xlsxRead.js';
import { decodeBuffer } from './decodeText.js';
import { toAgorot } from './money.js';

// "דוח פדיון" — parse the nightly revenue report (XLS/XLSX/CSV) into daily rows.
// The exact column titles vary by POS vendor, so headers are auto-detected from a list of known
// Hebrew/English names; when detection fails the caller can pass an explicit column mapping
// (same idea as the master-catalog import), so a new report format never blocks the owner.

const DATE_HEADS = ['תאריך', 'תאריך עסקי', 'יום', 'date', 'business date', 'תאריך דוח'];
const SALES_HEADS = [
  'פדיון', 'סה"כ פדיון', 'סהכ פדיון', 'מכירות', 'סה"כ מכירות', 'סהכ מכירות', 'סה"כ', 'סהכ',
  'total', 'sales', 'gross', 'turnover', 'הכנסות', 'פדיון יומי', 'סך המכירות',
];
const CREDIT_HEADS = [
  'אשראי', 'סליקה', 'סליקות', 'סליקת אשראי', 'סליקות אשראי', 'כרטיסי אשראי', 'credit', 'card',
  'סה"כ אשראי', 'סהכ אשראי',
];

const norm = (s) => String(s ?? '').replace(/["'`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Index of the first column whose header matches one of `names` (exact, then contains). */
function findCol(headers, names) {
  const h = headers.map(norm);
  const wanted = names.map(norm);
  let i = h.findIndex((x) => x && wanted.includes(x));
  if (i !== -1) return i;
  i = h.findIndex((x) => x && wanted.some((w) => x.includes(w)));
  return i;
}

/**
 * Normalise a date cell to 'YYYY-MM-DD'. Accepts ISO, DD/MM/YYYY, DD-MM-YY and an Excel serial.
 * Day-first, matching how Israeli reports print dates.
 */
export function normalizeReportDate(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/.exec(raw);
  if (m) {
    const d = m[1].padStart(2, '0');
    const mo = m[2].padStart(2, '0');
    let y = m[3];
    if (y.length === 2) y = `20${y}`;
    return `${y}-${mo}-${d}`;
  }
  // Excel serial day number (days since 1899-12-30).
  if (/^\d{5}$/.test(raw)) {
    const ms = (Number(raw) - 25569) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return null;
}

/**
 * Split raw CSV/TSV text into string[][] — keeping EVERY row (header included) and every column.
 * `lib/csv.js` returns objects keyed by the first row, which would drop the header line and
 * collapse repeated blank headers; revenue reports often carry title rows above the real header,
 * so we need the raw grid. Handles quoted fields and picks the delimiter used by the first line
 * (Israeli Excel exports are frequently semicolon- or tab-separated).
 */
function splitDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => (firstLine.split(ch).length - 1);
  const delim = count(';') > count(',') ? ';' : count('\t') > count(',') ? '\t' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += c;
    } else if (c === '"' && field === '') inQuotes = true; // a bare " mid-field (סה"כ) is literal
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Rows of the file as string[][] (first sheet for xlsx, raw grid otherwise). */
function toRows(buf) {
  if (looksLikeXlsx(buf)) return readXlsx(buf);
  return splitDelimited(decodeBuffer(buf));
}

/**
 * Parse a revenue report.
 * @param {Buffer} buf                       file bytes
 * @param {{date?:number, sales?:number, credit?:number}} [mapping]  explicit 0-based column indexes
 * @returns {{rows:Array<{date:string,gross:number,credit:number}>, headers:string[],
 *            detected:{date:number,sales:number,credit:number}, warnings:string[]}}
 */
export function parseRevenueReport(buf, mapping = {}) {
  const all = toRows(buf).filter((r) => r && r.some((c) => String(c ?? '').trim() !== ''));
  const warnings = [];
  if (!all.length) return { rows: [], headers: [], detected: { date: -1, sales: -1, credit: -1 }, warnings: ['הקובץ ריק'] };

  // The header is the first row that yields a date column (reports often carry title rows above it).
  let headerIdx = 0;
  let headers = all[0];
  let dateCol = Number.isInteger(mapping.date) ? mapping.date : findCol(headers, DATE_HEADS);
  if (!Number.isInteger(mapping.date)) {
    for (let i = 0; i < Math.min(all.length, 10) && dateCol === -1; i += 1) {
      const c = findCol(all[i], DATE_HEADS);
      if (c !== -1) { headerIdx = i; headers = all[i]; dateCol = c; }
    }
  }
  const salesCol = Number.isInteger(mapping.sales) ? mapping.sales : findCol(headers, SALES_HEADS);
  const creditCol = Number.isInteger(mapping.credit) ? mapping.credit : findCol(headers, CREDIT_HEADS);
  const detected = { date: dateCol, sales: salesCol, credit: creditCol };

  if (dateCol === -1) warnings.push('לא זוהתה עמודת תאריך — בחר אותה ידנית.');
  if (salesCol === -1) warnings.push('לא זוהתה עמודת פדיון/מכירות — בחר אותה ידנית.');
  if (creditCol === -1) warnings.push('לא זוהתה עמודת אשראי/סליקה — סליקות האשראי יירשמו 0.');
  if (dateCol === -1 || salesCol === -1) return { rows: [], headers, detected, warnings };

  const byDate = new Map(); // one row per business day; a repeated date sums (multi-register files)
  for (let i = headerIdx + 1; i < all.length; i += 1) {
    const r = all[i];
    const date = normalizeReportDate(r[dateCol]);
    if (!date) continue;
    const gross = toAgorot(r[salesCol]);
    const credit = creditCol === -1 ? 0 : toAgorot(r[creditCol]);
    if (!Number.isFinite(gross)) continue;
    const prev = byDate.get(date) || { date, gross: 0, credit: 0 };
    prev.gross += gross;
    prev.credit += credit;
    byDate.set(date, prev);
  }
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) warnings.push('לא נמצאו שורות עם תאריך תקין.');
  return { rows, headers, detected, warnings };
}
