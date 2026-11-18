// 🛒 פריטים שהמכר שלהם מוצג ליד הוצאת מזומן — בעלים 17/11: "בפינק כשיש הוצאות של ג'חנון או של פרחים
// אני רוצה שיופיע חישוב של מכר מימים שישי שבת וראשון שלפני ההוצאה (אם ההוצאה נרשמה ביום ראשון אז
// להכליל גם את היום ראשון הזה)". הספק של הג'חנון ושל הפרחים מקבל מזומן מהקופה; המכר של סוף השבוע
// הוא מה שמולו בודקים את התשלום.
//
// הפריטים — לפי מה שנמדד בדוח "פינק מכר יומי" (נובמבר 2026) ותשובת הבעלים ("גחנון רסק וביצה + ביצה"):
//   ג'חנון: 2588 "גחנון רסק וביצה" (₪25) + 91346728465 "ביצה חומה לג'חנון" (₪3). **לא** המוצרים הארוזים
//           ("ג'חנון צנעני", "לבדי ג'חנון חמסי", "גחנון אפוי מעדנות") — אלה של ספק אחר.
//   פרחים:  99134679 "זר פרחים 30 ש"ח" + 156473164 "זר פרחים 50 ש"ח", וכל פריט ששמו "זר פרחים" (מחיר חדש
//           = ברקוד חדש בקופה). **לא** "ורדים" — "מרכך בדין בריח ורדים" הוא מרכך כביסה.
// הזיהוי לפי ברקוד קודם, ולפי שם רק כגיבוי.

export const TRACKED_GROUPS = [
  {
    key: 'jachnun',
    label: 'ג׳חנון',
    icon: '🥙',
    codes: ['2588', '91346728465'],
    names: [/^גחנון רסק וביצה$/, /^ביצה חומה לג['׳]חנון$/],
    expense: /ג['׳]?חנון/,
  },
  {
    key: 'flowers',
    label: 'פרחים',
    icon: '💐',
    codes: ['99134679', '156473164'],
    names: [/^זר פרחים/],
    expense: /פרח/,
  },
];

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** הקבוצה של פריט בדוח (ברקוד, ואם לא — שם), או null. */
export function groupOfItem(code, name) {
  const c = String(code || '').trim();
  const n = norm(name);
  for (const g of TRACKED_GROUPS) if (c && g.codes.includes(c)) return g.key;
  for (const g of TRACKED_GROUPS) if (n && g.names.some((re) => re.test(n))) return g.key;
  return null;
}

/** הקבוצה שהוצאת מזומן מדברת עליה ("עבור" או "שם"), או null. */
export function groupOfExpense(expense) {
  const text = `${expense?.purpose || ''} ${expense?.payer_name || ''}`;
  return TRACKED_GROUPS.find((g) => g.expense.test(text)) || null;
}

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * שישי, שבת וראשון **שלפני** ההוצאה. הוצאה ביום ראשון — כולל אותו ראשון; בשאר הימים — סוף השבוע
 * האחרון שהסתיים (הוצאה ביום שישי או שבת = סוף השבוע הקודם, כי הנוכחי עוד לא הסתיים).
 * @param {string} dateIso 'YYYY-MM-DD'
 * @returns {{fri:string, sat:string, sun:string, days:string[]}|null}
 */
export function weekendBefore(dateIso) {
  const d = String(dateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay(); // 0 = ראשון
  const sun = addDays(d, -dow);
  const fri = addDays(sun, -2);
  const sat = addDays(sun, -1);
  return { fri, sat, sun, days: [fri, sat, sun] };
}
