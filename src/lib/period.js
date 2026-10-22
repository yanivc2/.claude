import { addDaysIso } from './loginHours.js';

// סינון לפי תקופה בשורת הכותרת (partials/_periodMenu.ejs; בעלים 22/10, עובדים ומשכורות: "מסנן לפי שבוע ולפי
// חודש למעלה משמאל לחזרה"). `?week=YYYY-MM-DD` = השבוע (א׳–ש׳) שמכיל את היום הזה; `?month=YYYY-MM[-DD]` = החודש.
// מחזיר { kind, from, to } (ISO, כולל שני הקצוות) או null — ערך לא תקין פשוט לא מסנן.
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_MONTH = /^(\d{4})-(\d{2})(?:-\d{2})?$/;

export function periodFromQuery(q = {}) {
  const w = ISO_DAY.exec(String(q.week || ''));
  if (w) {
    const d = new Date(Date.UTC(Number(w[1]), Number(w[2]) - 1, Number(w[3])));
    if (!Number.isNaN(d.getTime()) && d.getUTCDate() === Number(w[3])) {
      const from = addDaysIso(`${w[1]}-${w[2]}-${w[3]}`, -d.getUTCDay());
      return { kind: 'week', from, to: addDaysIso(from, 6), value: from };
    }
  }
  const m = ISO_MONTH.exec(String(q.month || ''));
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
    return { kind: 'month', from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}`, value: `${m[1]}-${m[2]}-01` };
  }
  return null;
}

/** " AND <col> BETWEEN ? AND ?" + params, or nothing when there is no period. */
export function periodClause(period, col) {
  if (!period) return { sql: '', params: [] };
  return { sql: ` AND ${col} >= ? AND ${col} <= ?`, params: [period.from, period.to] };
}
