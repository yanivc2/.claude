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
const GENERIC = new Set(['חברת', 'קבוצת', 'מפעלי', 'תעשיות', 'שיווק', 'הפצת', 'סחר', 'בע"מ', 'בעמ', 'בע', 'ltd']);

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

/** המילים שמזהות ספק — בלי הכלליות ובלי אות בודדת ("בע"מ" → "בע", "מ"). */
function nameWords(name) {
  return clean(name).split(' ').filter((w) => w && w.length > 1 && !GENERIC.has(w));
}

/**
 * **כמה טוב** ההוצאה מזכירה את הספק: 0 = לא מזכירה (המילה המזהה חסרה — `mentionsSupplier`); אחרת החלק
 * מבין מילות השם שכתובות בהוצאה, עד 1. בעלים 17/11: "תציג קודם כל ספק שיש התאמה לשם שלו בהוצאה, ככל
 * שההתאמה יותר טובה כך זה יופיע יותר קרוב" — "מוצרי איכות קנדיים" מול הוצאה "מוצרי איכות קנדיים" = 1,
 * "מוצרי איכות אמריקאיים" מולה = ⅔ (מוזכר — אבל אחריו).
 */
export function mentionScore(expense, supplierName) {
  if (!mentionsSupplier(expense, supplierName)) return 0;
  const ws = nameWords(supplierName);
  if (!ws.length) return 0;
  const text = wordsOf(`${expense?.payer_name || ''} ${expense?.purpose || ''}`);
  return ws.filter((w) => text.has(w)).length / ws.length;
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

/** "כמעט אותו סכום" — עד ₪1 (באגורות). עיגול בקופה: ₪1,684.00 שולמו על חשבונית של ₪1,683.99 (בעלים 17/11). */
export const NEAR_AGOROT = 100;

/**
 * מדרג את החשבוניות להוצאה אחת. 🔴 **קודם הספק שבשם ההוצאה, ההתאמה הטובה ביותר ראשונה** (`mentionScore`;
 * בעלים 17/11: "תציג קודם כל ספק שיש התאמה לשם שלו בהוצאה, ככל שההתאמה יותר טובה כך זה יופיע יותר קרוב"),
 * ובתוך כל קבוצה — ואחריהן, לכל השאר — **הסכום הקרוב ביותר** (בעלים 17/11: "הכי חשוב שהתוצאות הראשונות יהיו
 * הסכומים הכי קרובים"); ★ אותו סכום הוא הפרש 0. כשההוצאה לא מזכירה אף ספק — הסכום הקרוב בלבד, כמו קודם.
 * בשוויון: קרבת תאריך → חדש יותר. מעבר ל-`limit` נשמרות גם חשבוניות של ספק שבשם ומיום ה-Z (±2), כדי
 * שסכום שונה (תשלום חלקי, צירוף) לא ייחתך מהרשימה.
 * @returns {Array} אותן חשבוניות עם `sameAmount`, `nearAmount`, `diff` (אגורות, מוחלט), `nameScore`, `nameMatch`, `gap`
 */
export function rankInvoices(expense, invoices, limit = 60) {
  const target = Number(expense?.amount) || 0;
  const date = expense?.expense_date || null;
  const scored = (invoices || []).map((r) => {
    const diff = Math.abs(Number(r.total_amount) - target);
    return {
      ...r,
      diff,
      sameAmount: diff === 0,
      nearAmount: diff > 0 && diff <= NEAR_AGOROT,
      nameScore: mentionScore(expense, r.supplier_name),
      gap: dayGap(r.invoice_date, date),
    };
  });
  for (const r of scored) r.nameMatch = r.nameScore > 0;
  scored.sort((a, b) => (b.nameScore - a.nameScore) || (a.diff - b.diff) || (a.gap - b.gap)
    || String(b.invoice_date || '').localeCompare(String(a.invoice_date || '')));
  return scored.filter((r, i) => i < limit || r.nameMatch || r.gap <= 2);
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

/** הספקים שההוצאה מזכירה בשמם (מתוך רשימת שמות), בלי כפולים — **ההתאמה הטובה ביותר ראשונה** (`mentionScore`). */
export function suppliersMentioned(expense, supplierNames) {
  const seen = new Set();
  const out = [];
  for (const n of supplierNames || []) {
    if (!n || seen.has(n)) continue;
    const score = mentionScore(expense, n);
    if (!score) continue;
    seen.add(n);
    out.push({ n, score, i: out.length });
  }
  return out.sort((a, b) => (b.score - a.score) || (a.i - b.i)).map((o) => o.n);
}
