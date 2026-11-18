// 🛒 קריאת דוח הקופה "דוח מכירות פריטים מפורט בחתך רווח ועלות" (בפינק: המייל "פינק מכר יומי", PDF, נשלח
// ~01:00 על היום הקודם). pdfGrid בונה שורות ותאים מהמיקומים; כאן נשלפים מהן רק הפריטים שבמעקב
// (lib/trackedItems.js) — לא כל הדוח.
//
// מבנה השורה, משמאל לימין (כפי שנמדד, נובמבר 2026):
//   % תרומה | רווח כספי | % רווח | סה"כ | הנחה | מחיר | עלות | כמות | תיאור | ברקוד
// תיאור ארוך נשבר לשורה נפרדת, ואז בשורת המספרים חסר התא שלו — לכן העמודות המספריות נקראות לפי מקומן
// בכותרת מימין-לשמאל של הטבלה (משמאל), והברקוד הוא תמיד התא האחרון.
// 🔴 הדוח חייב להיות של **יום אחד** ("מתאריך" עד "עד" = יום). דוח של כמה ימים נדחה — אחרת יום אחד
// היה נושא מכר של שבוע ונספר בשבוע אחר.
import { pdfGrid } from './pdfGrid.js';
import { groupOfItem } from './trackedItems.js';

const num = (s) => {
  const v = Number(String(s ?? '').replace(/[,\s₪]/g, ''));
  return Number.isFinite(v) ? v : null;
};
const agorot = (v) => Math.round(v * 100);
const dmyToIso = (s) => {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};
const nextDay = (iso) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * @param {string[][]} grid  שורות הדוח (pdfGrid)
 * @returns {{date:string|null, totalSales:number|null, rows:Array<{code,name,qty,price,discount,total}>, tracked:Array, warnings:string[], error?:string}}
 */
export function parseItemSalesGrid(grid) {
  const rows = grid || [];
  const warnings = [];
  const flat = (r) => r.join(' ');
  if (!rows.some((r) => /דוח מכירות פריטים/.test(flat(r)))) {
    return { date: null, totalSales: null, rows: [], tracked: [], warnings, error: 'not an item-sales report' };
  }
  // "מתאריך:" ו"עד:" — הערך הוא התא שמשמאל לתווית (ב-RTL: אחריה).
  let from = null;
  let to = null;
  for (const r of rows) {
    const i = r.findIndex((c) => /^מתאריך:?$/.test(String(c).trim()));
    const j = r.findIndex((c) => /^עד:?$/.test(String(c).trim()));
    if (i > 0) from = dmyToIso(r[i - 1]);
    if (j > 0) to = dmyToIso(r[j - 1]);
    if (from || to) break;
  }
  if (!from) return { date: null, totalSales: null, rows: [], tracked: [], warnings, error: 'no report date' };
  if (to && to !== nextDay(from)) {
    return { date: from, totalSales: null, rows: [], tracked: [], warnings, error: `period report (${from} → ${to})` };
  }

  const h = rows.findIndex((r) => r.includes('ברקוד') && r.includes('כמות') && r.some((c) => /^סה"כ$/.test(c)));
  if (h < 0) return { date: from, totalSales: null, rows: [], tracked: [], warnings, error: 'no header row' };
  const head = rows[h];
  const col = (re) => head.findIndex((c) => re.test(String(c).trim()));
  const iTotal = col(/^סה"כ$/);
  const iDisc = col(/^הנחה$/);
  const iPrice = col(/^מחיר$/);
  const iQty = col(/^כמות$/);
  const iName = col(/^תיאור$/);

  const out = [];
  let totalSales = null;
  for (let k = h + 1; k < rows.length; k += 1) {
    const r = rows[k];
    if (r.some((c) => /סה"כ שורות/.test(c))) {
      const t = num(r[iTotal]);
      if (t != null) totalSales = agorot(t);
      continue;
    }
    const code = String(r[r.length - 1] || '').trim();
    if (!/^\d{3,14}$/.test(code) || r.length < iQty + 2) continue;
    const qty = num(r[iQty]);
    const total = num(r[iTotal]);
    if (qty == null || total == null) continue;
    const price = num(r[iPrice]);
    const discount = num(r[iDisc]) || 0;
    // התיאור רק כשהוא בשורה (אורך מלא); אחרת הוא נשבר לשורה סמוכה — הזיהוי לפי ברקוד.
    const name = r.length === head.length ? String(r[iName] || '').trim() : '';
    out.push({ code, name, qty, price, discount, total: agorot(total) });
  }

  const tracked = [];
  for (const it of out) {
    const group = groupOfItem(it.code, it.name);
    if (!group) continue;
    if (it.price != null && Math.abs(agorot(it.qty * it.price - it.discount) - it.total) > 1) {
      warnings.push(`${it.name || it.code}: כמות × מחיר − הנחה ≠ סה"כ — נשמר הסה"כ שבדוח`);
    }
    tracked.push({ group, code: it.code, name: it.name, qty: Math.round(it.qty), sales: it.total });
  }
  return { date: from, totalSales, rows: out, tracked, warnings };
}

/** PDF → אותו פלט. */
export async function parseItemSalesPdf(buf) {
  return parseItemSalesGrid(await pdfGrid(buf));
}
