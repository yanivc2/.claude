import { readXlsx, looksLikeXlsx } from './xlsxRead.js';
import { readXls, looksLikeXls } from './xlsRead.js';
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

/** Rows of the file as string[][] — .xlsx (ZIP), legacy .xls (OLE2/BIFF), or delimited text. */
function toRows(buf) {
  if (looksLikeXlsx(buf)) return readXlsx(buf);
  if (looksLikeXls(buf)) return readXls(buf); // the POS report is a legacy JasperReports .xls
  return splitDelimited(decodeBuffer(buf));
}

/**
 * Money out of a report cell: '23401.64 ₪', '35028.74₪', '1,234.50' → agorot. A percentage
 * ('66.81 %') is not money and returns null, as does anything without a digit.
 */
export function parseMoneyLoose(v) {
  const s = String(v ?? '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
  if (!s || s.includes('%')) return null;
  const cleaned = s.replace(/[^\d.,-]/g, '').replace(/,/g, '');
  if (!/\d/.test(cleaned)) return null;
  const n = Number.parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

// Labels are matched on a squeezed key so gershayim/quotes/spacing never matter:
// 'סה"כ פדיון(כולל ת.חוב)' → 'סהכפדיון(כוללת.חוב)'.
const labelKey = (s) => String(s ?? '').replace(/["'\u05f4\u05f3]/g, '').replace(/\s+/g, '').trim();

/**
 * Parse the POS "דוח פדיון" **summary** shape: one business day laid out as label→value rows in
 * RTL (the label is the right-most cell, its figures sit to the left), e.g.
 *   כרטיס אשראי | 361 | 23401.64 ₪ | 66.81 %
 *   סה"כ פדיון(כולל ת.חוב) | 35455.84₪
 * The file carries NO date — the caller supplies the business day.
 * @returns {{gross:number, credit:number, cash:number}|null}
 */
export function parseSummaryGrid(grid) {
  const rows = [];
  for (const row of grid || []) {
    if (!row || !row.length) continue;
    let li = -1;
    for (let i = row.length - 1; i >= 0; i -= 1) if (String(row[i] ?? '').trim()) { li = i; break; }
    if (li <= 0) continue; // need a label plus at least one value to its left
    rows.push({
      key: labelKey(row[li]),
      values: row.slice(0, li).map((v) => String(v ?? '').trim()).filter(Boolean),
    });
  }
  if (!rows.length) return null;
  const find = (pred) => rows.find((r) => pred(r.key));
  const money = (r) => {
    if (!r) return null;
    const ils = r.values.find((v) => v.includes('₪'));
    if (ils !== undefined) return parseMoneyLoose(ils);
    for (const v of r.values) { const m = parseMoneyLoose(v); if (m !== null) return m; }
    return null;
  };
  // "פדיון" is the headline the owner asked for; fall back to the sales totals.
  const gross =
    money(find((k) => k.includes('סהכפדיון'))) ??
    money(find((k) => k.includes('סהכמכיר')));
  if (gross === null) return null;
  return {
    gross,
    credit: money(find((k) => k === 'כרטיסאשראי')) ?? 0,
    cash: money(find((k) => k === 'מזומן')) ?? 0,
  };
}

/**
 * Parse a revenue report.
 * @param {Buffer} buf                       file bytes
 * @param {{date?:number, sales?:number, credit?:number}} [mapping]  explicit 0-based column indexes
 * @returns {{rows:Array<{date:string,gross:number,credit:number}>, headers:string[],
 *            detected:{date:number,sales:number,credit:number}, warnings:string[]}}
 */
export function parseRevenueReport(buf, opts = {}) {
  // Back-compat: the 2nd argument may be a column mapping ({date:0,sales:2}) or an options object
  // ({ reportDate:'YYYY-MM-DD' }). Numeric keys = mapping; a string date = the business day.
  const mapping = {};
  for (const k of ['date', 'sales', 'credit']) if (typeof opts[k] === 'number') mapping[k] = opts[k];
  const reportDate = typeof opts.reportDate === 'string' ? opts.reportDate
    : (typeof opts.date === 'string' ? opts.date : null);
  return parseTabularOrSummary(buf, mapping, reportDate);
}

function parseTabularOrSummary(buf, mapping, reportDate) {
  const all = toRows(buf).filter((r) => r && r.some((c) => String(c ?? '').trim() !== ''));
  const warnings = [];
  if (!all.length) return { rows: [], headers: [], detected: { date: -1, sales: -1, credit: -1 }, warnings: ['הקובץ ריק'], kind: 'unknown', summary: null };

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
  if (dateCol === -1 || salesCol === -1) {
    // No per-day table → try the POS summary shape (one business day, label→value, no date in the
    // file). The caller supplies the business day; without it we report what we found and ask.
    const summary = parseSummaryGrid(all);
    if (summary) {
      return {
        kind: 'summary',
        summary,
        rows: reportDate ? [{ date: reportDate, gross: summary.gross, credit: summary.credit }] : [],
        headers,
        detected,
        warnings: reportDate ? [] : ['דוח יומי מסוכם — הקובץ אינו מכיל תאריך. בחר את תאריך הדוח.'],
      };
    }
    return { rows: [], headers, detected, warnings, kind: 'unknown', summary: null };
  }

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
  return { rows, headers, detected, warnings, kind: 'daily', summary: null };
}
