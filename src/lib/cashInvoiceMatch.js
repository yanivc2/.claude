// התאמת הוצאת מזומן לחשבוניות — הצד הטהור (בלי מסד), כדי שאפשר יהיה לבדוק אותו עד הסוף.
//
// בעלים, 16/10: "היא משלמת טרה וקולה יחד ... אני לא מצליח למצוא את החשבונית המתאימה של טרה". הוצאה
// אחת ששילמה שני ספקים לא מתאימה בסכום לאף חשבונית בודדת, ולכן ה-★ ("אותו סכום") לא הופיע, והרשימה
// מוינה רק לפי תאריך — חשבונית טרה של אותו יום נבלעה בין עשרות. כאן שלושה סימנים במקום אחד:
//   1. אותו סכום (★) — כמו קודם.
//   2. **השם** — ספק שהשם שלו כתוב ב"שם"/"עבור" של ההוצאה ("טרה", "קוקה קולה").
//   3. **התאריך** — חשבונית מיום ה-Z קודמת לחשבונית מלפני שבוע ("ביום הזנת ה-Z צריכה להיות מוזנת
//      חשבונית מתאימה").
// ובנוסף **צירוף**: 2-3 חשבוניות סמוכות לתאריך שסכומן יחד שווה בדיוק לסכום ההוצאה.

const PREFIXES = /^[והבלמשכ]/;
// מילים שפותחות שם ספק ואינן מזהות אותו ("חברת טרה" → "טרה").
const GENERIC = new Set(['חברת', 'קבוצת', 'מפעלי', 'תעשיות', 'שיווק', 'הפצת', 'סחר', 'בע"מ', 'בעמ', 'ltd']);

const clean = (s) => String(s || '').toLowerCase().replace(/[׳״"'`.,;:()\-_/\\]+/g, ' ').replace(/\s+/g, ' ').trim();

/** מילות הטקסט, כל אחת גם בלי אות שימוש בתחילתה ("וקולה" → "קולה"). */
function wordsOf(text) {
  const out = new Set();
  for (const w of clean(text).split(' ')) {
    if (!w) continue;
    out.add(w);
    if (w.length > 3 && PREFIXES.test(w)) out.add(w.slice(1));
  }
  return out;
}

/** המילה שמזהה ספק: הראשונה בשמו שאינה כללית. */
function keyWord(name) {
  const ws = clean(name).split(' ').filter((w) => w && !GENERIC.has(w));
  return ws[0] || null;
}

/** האם ההוצאה (שם + עבור) מזכירה את הספק. */
export function mentionsSupplier(expense, supplierName) {
  const k = keyWord(supplierName);
  if (!k || k.length < 2) return false;
  const text = `${expense?.payer_name || ''} ${expense?.purpose || ''}`;
  return wordsOf(text).has(k);
}

const dayGap = (a, b) => {
  if (!a || !b) return 999;
  const d = Math.abs(Date.parse(String(a).slice(0, 10)) - Date.parse(String(b).slice(0, 10))) / 86_400_000;
  return Number.isFinite(d) ? d : 999;
};

/**
 * מדרג את החשבוניות הפתוחות להוצאה אחת: ★ אותו סכום → הספק מוזכר בשם → קרבת תאריך → חדש יותר.
 * @returns {Array} אותן חשבוניות עם `sameAmount`, `nameMatch`, `gap`
 */
export function rankInvoices(expense, invoices, limit = 60) {
  const target = Number(expense?.amount) || 0;
  const date = expense?.expense_date || null;
  const scored = (invoices || []).map((r) => ({
    ...r,
    sameAmount: Number(r.total_amount) === target,
    nameMatch: mentionsSupplier(expense, r.supplier_name),
    gap: dayGap(r.invoice_date, date),
  }));
  scored.sort((a, b) => (b.sameAmount - a.sameAmount) || (b.nameMatch - a.nameMatch) || (a.gap - b.gap)
    || String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')));
  return scored.slice(0, limit);
}

/**
 * צירופים של 2-3 חשבוניות **סמוכות לתאריך ההוצאה** (עד 3 ימים) שסכומן יחד שווה בדיוק לסכום ההוצאה.
 * צירוף שכולל ספק שמוזכר בשם קודם; אחריו הקטן יותר והקרוב יותר. עד `max` צירופים.
 */
export function invoiceCombos(expense, ranked, { maxDays = 3, pool = 30, max = 3 } = {}) {
  const target = Number(expense?.amount) || 0;
  if (target <= 0) return [];
  const near = (ranked || []).filter((r) => r.gap <= maxDays && Number(r.total_amount) > 0 && Number(r.total_amount) < target)
    .slice(0, pool);
  const found = [];
  const push = (items) => found.push({
    ids: items.map((r) => Number(r.id)),
    items,
    names: items.filter((r) => r.nameMatch).length,
    gap: items.reduce((n, r) => n + r.gap, 0),
  });
  for (let i = 0; i < near.length; i += 1) {
    for (let j = i + 1; j < near.length; j += 1) {
      const s2 = Number(near[i].total_amount) + Number(near[j].total_amount);
      if (s2 === target) push([near[i], near[j]]);
      if (s2 >= target) continue;
      for (let k = j + 1; k < near.length; k += 1) {
        if (s2 + Number(near[k].total_amount) === target) push([near[i], near[j], near[k]]);
      }
    }
  }
  found.sort((a, b) => (b.names - a.names) || (a.items.length - b.items.length) || (a.gap - b.gap));
  return found.slice(0, max);
}

/** הספקים שההוצאה מזכירה בשמם (מתוך רשימת שמות), בלי כפולים. */
export function suppliersMentioned(expense, supplierNames) {
  const seen = new Set();
  const out = [];
  for (const n of supplierNames || []) {
    if (!n || seen.has(n) || !mentionsSupplier(expense, n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
