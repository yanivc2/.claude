// הוצאת מזומן אחת ששילמה כמה חשבוניות (בעלים, 2026-10-12: "אפשר לבחור יותר מחשבונית אחת").
//
// הצורה: `invoice_ids` = כל המזהים ",12,15," על שורת ההוצאה (z_expenses / z_closing_expenses),
// ו-`invoice_id` נשאר **הראשונה** — כך כל מי שכבר קורא את `invoice_id` (רשימת "ללא התאמה",
// התצוגות, ההתאמה הידנית) ממשיך לעבוד בלי שינוי, ורק מי ששואל "אילו הוצאות שילמו את חשבונית X"
// צריך לחפש גם ב-`invoice_ids`. טקסט ולא טבלת קישור: שורות ההוצאה נמחקות ונוצרות מחדש בכל שמירה
// של הטופס, וטבלת קישור הייתה צריכה לעקוב אחרי זה בשני מסלולי הזנה.
import { getExecutor } from '../db/adapter.js';

/** "12,15" / [12, '15'] / 12 / ",12,15," → [12, 15] — שלמים חיוביים, בלי כפולים, בסדר הופעתם. */
export function parseInvoiceIds(v) {
  const out = [];
  for (const part of [].concat(v ?? []).flatMap((p) => String(p ?? '').split(','))) {
    const n = Number(String(part).trim());
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
  }
  return out;
}

/** [12, 15] → ",12,15," — פסיק בשני הקצוות, כדי ש-`LIKE '%,12,%'` לא יתפוס את 112. ריק → null. */
export function encodeInvoiceIds(ids) {
  const list = parseInvoiceIds(ids);
  return list.length ? `,${list.join(',')},` : null;
}

/** כל החשבוניות של שורת הוצאה: `invoice_ids`, ובשורה שנשמרה לפני העמודה — `invoice_id` לבד. */
export function rowInvoiceIds(row) {
  const list = parseInvoiceIds(row?.invoice_ids);
  return list.length ? list : parseInvoiceIds(row?.invoice_id);
}

export const likeInvoiceId = (id) => `%,${Number(id)},%`;

/**
 * 🔴 probe (CLAUDE.md): עד "עדכן מסד נתונים" העמודה לא קיימת, ו-INSERT שמזכיר אותה היה מפיל
 * את שמירת דוח ה-Z כולו. בלעדיה נשמרת החשבונית הראשונה בלבד, והטופס אומר זאת בקול.
 * לא לקרוא בתוך טרנזקציה: ב-Postgres SELECT שנכשל מבטל את כל הטרנזקציה.
 */
export async function cashExpenseInvoiceIdsReady(x = getExecutor()) {
  try {
    await x.many('SELECT invoice_ids FROM z_expenses LIMIT 1', []);
    await x.many('SELECT invoice_ids FROM z_closing_expenses LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}
