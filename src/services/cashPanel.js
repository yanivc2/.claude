// מה שטבלת "תשלום במזומן ללא התאמה" צריכה מעבר לשורות עצמן — מקור אחד לשני הדפים (לוח הבקרה
// ומרקורים), כדי שלא ייפרדו: ההוצאות שכבר הותאמו ("הותאם ל"), ואנשי הקשר לוואטסאפ.
import { getExecutor } from '../db/adapter.js';
import { matchedCashExpenses, pendingSettleKeys } from './zreports.js';
import { listEmployees } from './employees.js';

/** 05X-XXXXXXX / +972… → 9725XXXXXXXX (הפורמט של wa.me). לא מספר → null. */
export function waPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (/^972\d{8,9}$/.test(d)) return d;
  if (/^0\d{8,9}$/.test(d)) return `972${d.slice(1)}`;
  return null;
}

export async function cashPanelExtras(scope = null, storeId = null, x = getExecutor()) {
  const employees = await listEmployees({ scope }, x);
  return {
    matchedCash: await matchedCashExpenses(scope, 20, storeId, x),
    // "טופל" שהמזכירה סימנה וממתין לאישור הבעלים (מפתחות `source|id`).
    pendingSettle: await pendingSettleKeys(x),
    // וואטסאפ (בעלים, 16/10: "נסעו במונית ולא הביאו חשבונית — אסביר שבפעם הבאה זה לא ישולם"): עובדים
    // עם טלפון. בלי בחירה — וואטסאפ עצמו פותח בורר אנשי קשר.
    waContacts: employees.map((e) => ({ name: `${e.first_name || ''} ${e.last_name || ''}`.trim(), phone: waPhone(e.phone) }))
      .filter((c) => c.phone),
  };
}
