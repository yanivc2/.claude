import { readXlsx, looksLikeXlsx } from './xlsxRead.js';
import { readXls, looksLikeXls } from './xlsRead.js';
import { decodeBuffer } from './decodeText.js';
import { toAgorot } from './money.js';
import { looksLikePdf, pdfGrid } from './pdfGrid.js';

// "דוח פדיון" — parse the nightly revenue report (XLS/XLSX/CSV, or the PDF of it) into daily rows.
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

// Labels are matched on a squeezed key so gershayim/quotes/spacing/brackets never matter. The PDF
// prints brackets mirrored ('סה"כ מכירה)כולל הקפה(') — dropping them makes both formats one key:
// 'סה"כ פדיון(כולל ת.חוב)' → 'סהכפדיוןכוללת.חוב'.
const labelKey = (s) => String(s ?? '').replace(/["'\u05f4\u05f3()[\]]/g, '').replace(/\s+/g, '').trim();

const isIls = (v) => v.includes('₪');
const isCount = (v) => /^\d+$/.test(v.replace(/,/g, ''));

/**
 * Parse the POS "דוח פדיון" **summary** shape (Pidion_A4 — the same layout in XLS and PDF): one
 * business day laid out as label→value rows in RTL (the label is the right-most cell, its figures
 * sit to the left), in six tables:
 *   A  תקבולים בחתך אמצעי תשלום  כרטיס אשראי | מזומן | הקפה | סה"כ: ₪ + כמות קבלות (sales by tender)
 *   B  (only when debts were paid) the same rows for תשלומי חוב                (debt by tender)
 *   C  פירוט כרטיסי אשראי בחתך סולק  per acquirer: ₪ מכירות · ₪ תשלומי חוב · ₪ סה"כ + counts
 *   D  מכירות בחתך סוג עסקה          ממוצע לעסקה · סכום · כמות עסקאות
 *   E  פירוט ביטולים והנחות          סהכ ביטולים / סהכ הנחות / סהכ קבלות מבוטלות: ₪ + כמות
 *   F  פירוט מע"מ / totals           סה"כ מכירה(כולל הקפה) · … · סה"כ פדיון(כולל ת.חוב)
 * The XLS carries NO date; the PDF prints "מתאריך … עד …" (see reportRangeFromGrid).
 *
 * gross = סה"כ מכירה (כולל הקפה): what was SOLD that day — the profitability basis. "פדיון (כולל
 * ת.חוב)" adds debts collected for earlier sales, which would count those sales twice.
 * @returns {null|{gross:number, credit:number, cash:number, onAccount:number, debtPayments:number,
 *   debtCredit:number, cards:Array<{name:string, sales:number, debt:number, total:number,
 *   count:number|null}>, cardsTotal:number, txnCount:number|null, cancelAmount:number,
 *   cancelCount:number|null, creditCount:number|null, cashCount:number|null, receiptCount:number|null,
 *   discountAmount:number, discountCount:number, voidAmount:number, voidCount:number}}
 */
export function parseSummaryGrid(grid) {
  const rows = [];
  for (const row of grid || []) {
    if (!row || !row.length) continue;
    let li = -1;
    for (let i = row.length - 1; i >= 0; i -= 1) if (String(row[i] ?? '').trim()) { li = i; break; }
    if (li <= 0) continue; // need a label plus at least one value to its left
    const values = row.slice(0, li).map((v) => String(v ?? '').trim()).filter(Boolean);
    rows.push({ label: String(row[li]).trim(), key: labelKey(row[li]), values, ils: values.filter(isIls) });
  }
  if (!rows.length) return null;
  const money = (r) => {
    if (!r) return null;
    if (r.ils.length) return parseMoneyLoose(r.ils[r.ils.length - 1]);
    for (const v of r.values) { const m = parseMoneyLoose(v); if (m !== null) return m; }
    return null;
  };
  const count = (r) => { const c = r && [...r.values].reverse().find(isCount); return c === undefined ? null : Number(c.replace(/,/g, '')); };
  const find = (pred, from = 0, to = rows.length) => rows.slice(from, to).find((r) => pred(r.key));

  const gross =
    money(find((k) => k.includes('סהכמכירהכוללהקפה'))) ??
    money(find((k) => k.includes('סהכפדיון'))) ??
    money(find((k) => k.includes('סהכמכיר')));
  if (gross === null) return null;

  // Table A ends at the first "סה"כ"; table C is the rows with three ₪ figures (מכירות/חוב/סה"כ).
  // Whatever single-figure rows sit between them are table B — the tenders debts were paid in.
  const endA = rows.findIndex((r) => r.key === 'סהכ');
  const cStart = rows.findIndex((r) => r.ils.length >= 3);
  const aTo = endA === -1 ? rows.length : endA;
  const tender = (key, from, to) => money(find((k) => k === key, from, to)) ?? 0;
  const receipts = (key) => count(find((k) => k === key, 0, aTo)); // "כמות קבלות" of a tender in table A
  const debtCredit = endA !== -1 && cStart > endA ? tender('כרטיסאשראי', endA + 1, cStart) : 0;

  const cards = rows
    .filter((r) => r.ils.length >= 3 && r.key !== 'סהכ')
    .map((r) => {
      // RTL: right→left the figures read מכירות, תשלומי חוב, סה"כ — the reverse of cell order.
      const [sales, debt, total] = [...r.ils].reverse().map(parseMoneyLoose);
      return { name: r.label, sales: sales ?? 0, debt: debt ?? 0, total: total ?? 0, count: count(r) };
    });

  // Table D's total is the only "סה"כ" with exactly two ₪ figures (ממוצע לעסקה + סכום).
  const txnRow = rows.find((r) => r.key === 'סהכ' && r.ils.length === 2);
  // Table E. A line the POS left empty ("סהכ הנחות" with no figures) is dropped above → 0.
  const cancelRow = find((k) => k === 'סהכביטולים');
  const discountRow = find((k) => k === 'סהכהנחות');
  const voidRow = find((k) => k === 'סהכקבלותמבוטלות');
  return {
    gross,
    credit: tender('כרטיסאשראי', 0, aTo),
    cash: tender('מזומן', 0, aTo),
    onAccount: tender('הקפה', 0, aTo),
    creditCount: receipts('כרטיסאשראי'),
    cashCount: receipts('מזומן'),
    receiptCount: endA === -1 ? null : count(rows[endA]),
    debtPayments: money(find((k) => k === 'סהכתשלומיחוב')) ?? 0,
    debtCredit,
    cards,
    cardsTotal: cards.reduce((sum, c) => sum + c.total, 0),
    txnCount: count(txnRow),
    cancelAmount: money(cancelRow) ?? 0,
    cancelCount: cancelRow ? count(cancelRow) : null,
    discountAmount: money(discountRow) ?? 0,
    discountCount: discountRow ? count(discountRow) ?? 0 : 0,
    voidAmount: money(voidRow) ?? 0,
    voidCount: voidRow ? count(voidRow) ?? 0 : 0,
  };
}

/**
 * The days a PDF report covers, from its "מתאריך: … עד: …" line (RTL, so each date is the cell to
 * the LEFT of its label). 🔴 The end is EXCLUSIVE when it is a midnight: "עד 17/10/26 00:00:00"
 * stops at the start of the 17th, so the last day is the 16th — measured on the POS: the report for
 * the 17th alone reads "17/10 00:00 עד 18/10 00:00". An end with a time of day (23:59) is that day.
 * One day = `date`; longer = a period report (`date` null, `lastDay` = its last day).
 * @returns {null|{from:string, to:string, lastDay:string, date:string|null}}
 */
export function reportRangeFromGrid(grid) {
  for (const row of grid || []) {
    const cells = (row || []).map((c) => String(c ?? '').trim());
    const fi = cells.findIndex((c) => labelKey(c) === 'מתאריך:');
    const ti = cells.findIndex((c) => labelKey(c) === 'עד:');
    if (fi <= 0 || ti <= 0) continue;
    const stamp = (s) => /^(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(s);
    const f = stamp(cells[fi - 1]);
    const t = stamp(cells[ti - 1]);
    const from = f && normalizeReportDate(f[1]);
    const to = t && normalizeReportDate(t[1]);
    if (!from || !to) continue;
    const toMidnight = t[2] !== undefined && Number(t[2]) === 0 && Number(t[3]) === 0;
    let lastDay = to;
    if (toMidnight && to > from) {
      const d = new Date(`${to}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 1);
      lastDay = d.toISOString().slice(0, 10);
    }
    if (lastDay < from) lastDay = from;
    return { from, to, lastDay, date: lastDay === from ? from : null };
  }
  return null;
}

/** The store the PDF is printed for — its first line ("ג'וניור בעיר", "פינק מרקט י. ר. בע"מ"). */
function pdfStoreTitle(grid) {
  const first = (grid || []).find((r) => r && r.length && !/דוח|מתאריך/.test(r.join(' ')));
  return first ? first.join(' ').trim() : null;
}

/** The fields of a summary that become one revenue_reports row (besides the date). */
function summaryRow(sm) {
  return {
    gross: sm.gross, credit: sm.credit, cash: sm.cash, onAccount: sm.onAccount, debtPayments: sm.debtPayments,
    debtCredit: sm.debtCredit, cards: sm.cards, txnCount: sm.txnCount, cancelAmount: sm.cancelAmount, cancelCount: sm.cancelCount,
    cashCount: sm.cashCount, creditCount: sm.creditCount, receiptCount: sm.receiptCount,
    discountAmount: sm.discountAmount, discountCount: sm.discountCount, voidAmount: sm.voidAmount, voidCount: sm.voidCount,
  };
}

const dmy = (iso) => iso.split('-').reverse().join('/');

/**
 * A parsed summary → the parse result. The day comes from the file when it prints one (PDF) —
 * the file is the authority on what it reports — else from the caller (XLS has no date).
 */
function summaryResult(summary, { reportDate, range, storeTitle = null, headers = [], detected = { date: -1, sales: -1, credit: -1 } }) {
  const warnings = [];
  let date = reportDate || null;
  if (range && !range.date) {
    // A period report (owner, 18/10: "הנה דוחות הפידיון" — 01/10–16/10 per store, to fill the days
    // before the nightly intake). Its totals cannot be split into days, so it is kept as ONE period
    // (services/revenueReports.js#importRevenuePeriod) and profitability counts it only for a range
    // that contains all of it.
    return {
      kind: 'period', summary, fileDate: null, storeTitle,
      period: { from: range.from, to: range.lastDay, ...summaryRow(summary) },
      rows: [], headers, detected, warnings,
    };
  }
  if (range && range.date) {
    if (reportDate && reportDate !== range.date) warnings.push(`בקובץ כתוב ${dmy(range.date)} — הדוח נקלט לתאריך שבקובץ ולא ל-${dmy(reportDate)}.`);
    date = range.date;
  } else if (!reportDate) {
    warnings.push('דוח יומי מסוכם — הקובץ אינו מכיל תאריך. בחר את תאריך הדוח.');
  }
  return {
    kind: 'summary', summary, fileDate: range ? range.date : null, storeTitle,
    rows: date ? [{ date, ...summaryRow(summary) }] : [], headers, detected, warnings,
  };
}

function optionsOf(opts) {
  // Back-compat: the 2nd argument may be a column mapping ({date:0,sales:2}) or an options object
  // ({ reportDate:'YYYY-MM-DD' }). Numeric keys = mapping; a string date = the business day.
  const mapping = {};
  for (const k of ['date', 'sales', 'credit']) if (typeof opts[k] === 'number') mapping[k] = opts[k];
  const reportDate = typeof opts.reportDate === 'string' ? opts.reportDate
    : (typeof opts.date === 'string' ? opts.date : null);
  return { mapping, reportDate };
}

const nonEmpty = (r) => r && r.some((c) => String(c ?? '').trim() !== '');

/**
 * Parse a revenue spreadsheet (XLSX / legacy XLS / CSV). Synchronous; a PDF needs
 * parseRevenueReportAny.
 * @param {Buffer} buf                       file bytes
 * @param {{date?:number, sales?:number, credit?:number, reportDate?:string}} [opts]
 *        explicit 0-based column indexes and/or the business day of a dateless summary
 * @returns {{rows:Array<{date:string,gross:number,credit:number}>, headers:string[],
 *            detected:{date:number,sales:number,credit:number}, warnings:string[],
 *            kind:'daily'|'summary'|'unknown', summary:object|null}}
 */
export function parseRevenueReport(buf, opts = {}) {
  const { mapping, reportDate } = optionsOf(opts);
  return parseTabularOrSummary(toRows(buf).filter(nonEmpty), mapping, reportDate);
}

/**
 * Parse a revenue report in ANY format the POS sends: the spreadsheets above, or the PDF of the
 * same Pidion_A4 report (lib/pdfGrid.js rebuilds its cells). A PDF is always the summary shape and
 * carries its own day ("מתאריך … עד …").
 */
export async function parseRevenueReportAny(buf, opts = {}) {
  if (!looksLikePdf(buf)) return parseRevenueReport(buf, opts);
  const { reportDate } = optionsOf(opts);
  const refuse = (why) => ({ rows: [], headers: [], detected: { date: -1, sales: -1, credit: -1 }, kind: 'unknown', summary: null, warnings: [why] });
  let grid;
  try {
    grid = (await pdfGrid(buf)).filter(nonEmpty);
  } catch {
    return refuse('קובץ ה-PDF פגום או נעול בסיסמה — אי אפשר לקרוא אותו.');
  }
  const summary = parseSummaryGrid(grid);
  if (!summary) {
    return refuse(grid.length
      ? 'קובץ ה-PDF אינו דוח פדיון מוכר (Pidion_A4) — לא נמצאה בו שורת "סה"כ מכירה".'
      : 'בקובץ ה-PDF אין טקסט (כנראה סריקה) — שלח את הדוח מהקופה או את קובץ ה-XLS.');
  }
  return summaryResult(summary, { reportDate, range: reportRangeFromGrid(grid), storeTitle: pdfStoreTitle(grid) });
}

function parseTabularOrSummary(all, mapping, reportDate) {
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
    if (summary) return summaryResult(summary, { reportDate, headers, detected });
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
