// Serialize rows to CSV text (RFC-4180 quoting). Dependency-free counterpart to lib/csv.js.
// A UTF-8 BOM is prepended so Excel opens Hebrew correctly.

function escapeCell(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {string[]} headers  column headers (row 1)
 * @param {Array<Array<string|number|null>>} rows  data rows
 * @returns {string} CSV text with a UTF-8 BOM
 */
export function toCsv(headers, rows) {
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) lines.push(row.map(escapeCell).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
