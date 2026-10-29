// 🏛️ חשבון ארנונה — עזרי תקופה טהורים (השירות, תקציר בקשת העריכה והתצוגה משתמשים בהם). הכללים עצמם —
// services/invoices.js#arnonaFields.

/** 'YYYY-MM' מתוך 'YYYY-MM', 'YYYY-MM-DD' (בורר החודש) או 'MM/YY' · 'MM/YYYY' שהוקלד; אחרת null. */
export function arnonaMonth(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(s);
  if (m) return `${m[1]}-${m[2]}`;
  m = /^(0?[1-9]|1[0-2])\s*[/.-]\s*(\d{2}|\d{4})$/.exec(s);
  if (m) return `${m[2].length === 2 ? `20${m[2]}` : m[2]}-${m[1].padStart(2, '0')}`;
  return null;
}

/** התקופה כמו שהיא מודפסת על החשבון: '09-10/26'; חוצה שנה — '12/26-01/27'; חודש אחד — '09/26'. */
export function arnonaPeriodLabel(from, to) {
  const f = arnonaMonth(from);
  const t = arnonaMonth(to) || f;
  if (!f) return '';
  const [fy, fm] = f.split('-');
  const [ty, tm] = t.split('-');
  if (f === t) return `${fm}/${fy.slice(2)}`;
  return fy === ty ? `${fm}-${tm}/${fy.slice(2)}` : `${fm}/${fy.slice(2)}-${tm}/${ty.slice(2)}`;
}
