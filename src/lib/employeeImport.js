// Parse an owner-supplied staff list (.xlsx, or CSV/TSV with a header row) into employee rows for
// bulk import. Recognises Hebrew and English headers for name and phone, and normalises phones so
// the importer can dedupe by phone number.
import { looksLikeXlsx, readXlsx } from './xlsxRead.js';

// Header → field. Lower-cased; Hebrew is unaffected by casing. A column we don't recognise is null.
const HEADERS = {
  'שם פרטי': 'first', 'first name': 'first', firstname: 'first', first: 'first', 'שם': 'name',
  'שם משפחה': 'last', 'last name': 'last', lastname: 'last', last: 'last', surname: 'last',
  'שם מלא': 'name', 'שם העובד': 'name', עובד: 'name', name: 'name', 'full name': 'name',
  טלפון: 'phone', 'מספר טלפון': 'phone', נייד: 'phone', פלאפון: 'phone', 'מס טלפון': 'phone',
  "מס' טלפון": 'phone', phone: 'phone', mobile: 'phone', tel: 'phone', 'phone number': 'phone', cell: 'phone',
};

function headerKey(h) {
  return String(h ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Canonical form of a phone number for dedup/storage: digits only, with Israel's international
 * prefix folded back to a local leading zero (972-50-… → 050-…). Returns '' when there are no
 * digits. Two numbers that dial the same person compare equal.
 */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('972')) d = '0' + d.slice(3);
  return d;
}

// The file as a matrix of cell strings: an xlsx workbook, or a delimited text file.
function toRows(input) {
  if (Buffer.isBuffer(input) && looksLikeXlsx(input)) return readXlsx(input);
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length === 0) return [];
  const delimiter = (lines[0].match(/\t/g) || []).length >= (lines[0].match(/,/g) || []).length ? '\t' : ',';
  return lines.map((l) => l.split(delimiter).map((c) => c.replace(/^"(.*)"$/, '$1').trim()));
}

function mapHeaders(headerRow) {
  return (headerRow || []).map((h) => HEADERS[headerKey(h)] || null);
}

function splitName(full) {
  const parts = String(full ?? '').replace(/\s+/g, ' ').trim().split(' ');
  if (parts.length === 0 || parts[0] === '') return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Parse the file into `{ rows, stats }`. Each row: `{ firstName, lastName, phone }` (phone already
 * normalised). Rows with no name at all are dropped and counted in `stats.skippedNoName`.
 * @param {Buffer|string} input the raw file (xlsx) or its decoded text (csv/tsv)
 */
export function parseEmployeeFile(input) {
  const matrix = toRows(input);
  if (matrix.length < 2) return { rows: [], stats: { total: 0, skippedNoName: 0 } };
  const cols = mapHeaders(matrix[0]);
  // No recognised header → assume [name, phone] (or [first, last, phone]) by position.
  const hasKnown = cols.some((c) => c);
  const idx = (field) => cols.indexOf(field);
  const rows = [];
  let skippedNoName = 0;
  for (const r of matrix.slice(1)) {
    let first = '';
    let last = '';
    let phone = '';
    if (hasKnown) {
      if (idx('first') >= 0) first = (r[idx('first')] || '').trim();
      if (idx('last') >= 0) last = (r[idx('last')] || '').trim();
      if (!first && !last && idx('name') >= 0) ({ first, last } = splitName(r[idx('name')]));
      if (idx('phone') >= 0) phone = normalizePhone(r[idx('phone')]);
    } else {
      // Positional fallback: first non-phone-looking cells are the name, a digit-heavy cell is phone.
      const cells = r.map((c) => (c || '').trim());
      const phoneCell = cells.find((c) => normalizePhone(c).length >= 7 && /\d/.test(c) && c.replace(/\D/g, '').length >= 7);
      phone = normalizePhone(phoneCell || '');
      const nameCells = cells.filter((c) => c && c !== phoneCell);
      if (nameCells.length >= 2) { first = nameCells[0]; last = nameCells.slice(1).join(' '); }
      else if (nameCells.length === 1) ({ first, last } = splitName(nameCells[0]));
    }
    if (!first && !last) { skippedNoName += 1; continue; }
    rows.push({ firstName: first, lastName: last, phone });
  }
  return { rows, stats: { total: matrix.length - 1, skippedNoName } };
}
