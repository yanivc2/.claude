import { toAgorot } from './money.js';

// Normalize parsed CSV rows into bank_transactions shape. Auto-detects three shapes:
//   1. Bank Hapoalim export (Hebrew headers, separate חובה/זכות columns, אסמכתא = check number)
//   2. Single signed-amount column (Hebrew תאריך + סכום, or English date + amount)
//   3. Simple format (date, amount, description, reference) for hand-made CSVs
//
// A debit (חובה) becomes a negative amount, a credit (זכות) positive — matching how the
// reconciliation engine reads movements. `אסמכתא` maps to raw_reference, which for a שיק row
// is the check number → deterministic matching.

// Column aliases (lower-cased; Hebrew is unaffected by casing). parseCsv lower-cases headers,
// so match against lower-case here too.
const DATE_KEYS = ['תאריך', 'תאריך ערך', 'תאריך הפעולה', 'תאריך פעולה', 'value date', 'date'];
const DEBIT_KEYS = ['חובה', 'חובה ₪', 'debit'];
const CREDIT_KEYS = ['זכות', 'זכות ₪', 'credit'];
const AMOUNT_KEYS = ['סכום', 'סכום התנועה', 'סכום בש"ח', 'סכום בשח', 'amount'];
const DESC_KEYS = ['תיאור הפעולה', 'הפעולה', 'פרטים', 'תיאור', 'סוג תנועה', 'פעולה', 'הערה', 'description'];
const REF_KEYS = ['אסמכתא', 'אסמכתא/שיק', 'מספר אסמכתא', 'אסמכתה', 'reference', 'ref'];
const BALANCE_KEYS = ["יתרה לאחר פעולה", "יתרה בש''ח", 'יתרה בש"ח', 'יתרה', 'balance'];

/** Normalize a date cell to 'YYYY-MM-DD' (accepts ISO or DD/MM/YYYY, DD.MM.YYYY, DD-MM-YYYY). */
function normalizeDate(value) {
  const s = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const m2 = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2})$/); // 2-digit year
  if (m2) return `20${m2[3]}-${m2[2].padStart(2, '0')}-${m2[1].padStart(2, '0')}`;
  return s; // leave as-is; caller validates
}

/** Strip currency symbols / spaces / unicode minus so toAgorot accepts real bank cells. */
function cleanAmount(value) {
  return String(value || '')
    .replace(/[₪\s ]/g, '') // shekel sign, spaces, non-breaking space
    .replace(/[−‒–—]/g, '-') // unicode minus / dashes -> ASCII hyphen
    .trim();
}

function firstNonEmpty(row, keys) {
  for (const k of keys) {
    if (row[k] != null && String(row[k]).trim() !== '') return String(row[k]).trim();
  }
  return '';
}

function pick(keys, names) {
  return names.find((n) => keys.includes(n)) || null;
}

/**
 * @param {Array<Record<string,string>>} rows  output of parseCsv
 * @returns {Array<{txnDate:string, amount:number, description:string|null, rawReference:string|null}>}
 * @throws {Error} on a malformed row in the simple format (message includes the row number)
 */
export function normalizeBankRows(rows) {
  if (!rows || rows.length === 0) return [];
  const keys = Object.keys(rows[0]);

  const debitKey = pick(keys, DEBIT_KEYS);
  const creditKey = pick(keys, CREDIT_KEYS);
  const dateKey = pick(keys, DATE_KEYS);
  const amountKey = pick(keys, AMOUNT_KEYS);
  const refKey = pick(keys, REF_KEYS);
  const balanceKey = pick(keys, BALANCE_KEYS);
  const descKeys = DESC_KEYS.filter((n) => keys.includes(n));

  const parseBalance = (r) => {
    if (!balanceKey) return null;
    const raw = firstNonEmpty(r, [balanceKey]);
    if (!raw) return null;
    try { return toAgorot(cleanAmount(raw)); } catch { return null; }
  };

  const isBankFormat = !!(debitKey || creditKey || (dateKey && amountKey));

  const out = [];
  rows.forEach((r, i) => {
    if (isBankFormat) {
      let amount;
      if (debitKey || creditKey) {
        const debit = debitKey ? firstNonEmpty(r, [debitKey]) : '';
        const credit = creditKey ? firstNonEmpty(r, [creditKey]) : '';
        if (!debit && !credit) return; // no movement (balance-only / summary row) — skip
        amount = debit ? -toAgorot(cleanAmount(debit)) : toAgorot(cleanAmount(credit));
      } else {
        const raw = firstNonEmpty(r, [amountKey]);
        if (!raw) return; // no amount on this row — skip
        amount = toAgorot(cleanAmount(raw)); // may already carry a sign
      }
      const date = normalizeDate(firstNonEmpty(r, dateKey ? [dateKey] : []));
      if (!date) return; // rows without a date are summaries/footers — skip, don't fail
      const desc = descKeys.map((k) => firstNonEmpty(r, [k])).filter(Boolean).join(' — ') || null;
      const ref = refKey ? firstNonEmpty(r, [refKey]) || null : null;
      out.push({ txnDate: date, amount, description: desc, rawReference: ref, balanceAfter: parseBalance(r) });
    } else {
      if (!r.date || r.amount === undefined || r.amount === '') {
        const found = keys.filter((k) => k !== '').join(', ') || '—';
        throw new Error(
          `שורה ${i + 2}: חסר תאריך או סכום. לא זוהו עמודות בנק תקינות. ` +
            `העמודות שנמצאו בקובץ: ${found}. ודא שהקובץ כולל כותרות כגון תאריך/חובה/זכות או תאריך/סכום.`,
        );
      }
      out.push({
        txnDate: normalizeDate(r.date),
        amount: toAgorot(cleanAmount(r.amount)),
        description: r.description || null,
        rawReference: r.reference || null,
        balanceAfter: parseBalance(r),
      });
    }
  });
  return out;
}
