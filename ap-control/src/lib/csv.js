// Minimal RFC-4180-ish CSV parser (handles quoted fields, embedded commas/quotes/newlines).
// Small and dependency-free — sufficient for importing a bank export the secretary saved as CSV.

/**
 * Parse CSV text into an array of row objects keyed by the (trimmed, lowercased) header names.
 * @param {string} text
 * @returns {Array<Record<string,string>>}
 */
export function parseCsv(text) {
  const rows = parseRows(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const out = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (cells.length === 1 && cells[0] === '') continue; // skip blank line
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? '').trim();
    });
    out.push(obj);
  }
  return out;
}

function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  // last field/row
  row.push(field);
  rows.push(row);
  return rows;
}
