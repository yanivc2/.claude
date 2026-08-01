// Minimal RFC-4180-ish CSV parser (handles quoted fields, embedded commas/quotes/newlines).
// Small and dependency-free — sufficient for importing a bank export the secretary saved as CSV.
//
// Robust to the messes real bank/Excel exports arrive in:
//   • a leftover UTF-8 BOM on the first header,
//   • a non-comma delimiter (Hebrew Excel defaults to ';'; some exports use TAB),
//   • a few title / metadata lines before the real header row.

// Header tokens we recognise, used to locate the real header row when the file
// opens with title/metadata lines. Lower-cased; Hebrew is unaffected by casing.
const HEADER_TOKENS = [
  'תאריך', 'חובה', 'זכות', 'סכום', 'אסמכתא', 'תיאור', 'פרטים', 'יתרה',
  'date', 'amount', 'debit', 'credit', 'description', 'reference', 'balance',
];

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Pick the delimiter (',' ';' or TAB) by whichever is most frequent in the first non-empty lines. */
function detectDelimiter(text) {
  const sample = text.split('\n').filter((l) => l.trim() !== '').slice(0, 5).join('\n');
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (const c of sample) {
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c in counts) counts[c] += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}

function looksLikeHeader(cells) {
  const nonEmpty = cells.filter((c) => c.trim() !== '');
  if (nonEmpty.length < 2) return false;
  return nonEmpty.some((c) => {
    const v = c.trim().toLowerCase();
    return HEADER_TOKENS.some((t) => v.includes(t));
  });
}

/**
 * Parse CSV text into an array of row objects keyed by the (trimmed, lowercased) header names.
 * @param {string} text
 * @returns {Array<Record<string,string>>}
 */
export function parseCsv(text) {
  const clean = stripBom(String(text));
  const delimiter = detectDelimiter(clean);
  const allRows = parseRows(clean, delimiter).filter(
    (r) => !(r.length === 1 && r[0].trim() === ''),
  );
  if (allRows.length === 0) return [];

  // Skip leading metadata/title lines: use the first row that looks like a
  // header; fall back to the first row so simple hand-made CSVs still work.
  let headerIdx = allRows.findIndex(looksLikeHeader);
  if (headerIdx < 0) headerIdx = 0;

  const headers = allRows[headerIdx].map((h) => h.trim().toLowerCase());
  const out = [];
  for (let i = headerIdx + 1; i < allRows.length; i += 1) {
    const cells = allRows[i];
    if (cells.length === 1 && cells[0].trim() === '') continue; // skip blank line
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = (cells[idx] ?? '').trim();
    });
    out.push(obj);
  }
  return out;
}

function parseRows(text, delimiter = ',') {
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
    } else if (c === '"' && field === '') {
      // A quote is only significant at the START of a field (RFC 4180). Elsewhere it is a
      // literal character — real bank exports contain unescaped quotes like בע"מ / מע"מ.
      inQuotes = true;
    } else if (c === delimiter) {
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
