import { toAgorot } from './money.js';

// Normalize parsed CSV rows into bank_transactions shape. Auto-detects two formats:
//   1. Bank Hapoalim export (Hebrew headers, separate חובה/זכות columns, אסמכתא = check number)
//   2. Simple format (date, amount, description, reference) for hand-made CSVs
//
// A debit (חובה) becomes a negative amount, a credit (זכות) positive — matching how the
// reconciliation engine reads movements. `אסמכתא` maps to raw_reference, which for a שיק row
// is the check number → deterministic matching.

/** Normalize a date cell to 'YYYY-MM-DD' (accepts ISO or DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY). */
function normalizeDate(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s; // leave as-is; caller validates
}

function firstNonEmpty(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
}

/**
 * @param {Array<Record<string,string>>} rows  output of parseCsv
 * @returns {Array<{txnDate:string, amount:number, description:string|null, rawReference:string|null}>}
 * @throws {Error} on a malformed row in the simple format (message includes the row number)
 */
export function normalizeBankRows(rows) {
  if (!rows || rows.length === 0) return [];
  const keys = Object.keys(rows[0]);
  const isBankFormat = keys.includes('חובה') || keys.includes('זכות');

  const out = [];
  rows.forEach((r, i) => {
    if (isBankFormat) {
      const debit = firstNonEmpty(r, ['חובה']);
      const credit = firstNonEmpty(r, ['זכות']);
      if (!debit && !credit) return; // a row with no movement (e.g. balance-only) — skip
      const amount = debit ? -toAgorot(debit) : toAgorot(credit);
      const date = normalizeDate(firstNonEmpty(r, ['תאריך', 'תאריך ערך']));
      const desc =
        [firstNonEmpty(r, ['תיאור הפעולה']), firstNonEmpty(r, ['פרטים'])]
          .filter(Boolean)
          .join(' — ') || null;
      const ref = firstNonEmpty(r, ['אסמכתא']) || null;
      out.push({ txnDate: date, amount, description: desc, rawReference: ref });
    } else {
      if (!r.date || r.amount === undefined || r.amount === '') {
        throw new Error(`שורה ${i + 2}: חסר תאריך או סכום`);
      }
      out.push({
        txnDate: normalizeDate(r.date),
        amount: toAgorot(r.amount),
        description: r.description || null,
        rawReference: r.reference || null,
      });
    }
  });
  return out;
}
