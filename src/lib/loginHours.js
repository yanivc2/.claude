// Per-user login hours, evaluated in Israel time (Asia/Jerusalem). A user may hold a window
// [login_start, login_end] ('HH:MM'); outside it they can neither log in nor use an existing
// session. The owner is never restricted, and a user with no window is always allowed.

/** Current Israel wall-clock as { hhmm:'HH:MM', minutes:number-since-midnight }. */
export function israelClock(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return { hhmm: `${p.hour}:${p.minute}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

/** Today's date in Israel as 'YYYY-MM-DD' (Asia/Jerusalem) — not UTC, which can be a day off near midnight. */
export function israelToday(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(now); // en-CA formats as YYYY-MM-DD
}

/** Parse 'HH:MM' → minutes since midnight, or null if not a valid time. */
export function parseHhmm(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * May this user be logged in right now (Israel time)? Owner and users without a full window
 * are always allowed. Supports overnight windows (start > end).
 * @returns {{allowed:boolean, hhmm?:string, window?:string}}
 */
export function loginAllowedNow(user, now = new Date()) {
  if (!user || user.role === 'owner') return { allowed: true };
  const start = parseHhmm(user.login_start);
  const end = parseHhmm(user.login_end);
  if (start == null || end == null) return { allowed: true }; // no (complete) restriction
  const { minutes, hhmm } = israelClock(now);
  const within = start <= end
    ? (minutes >= start && minutes <= end)
    : (minutes >= start || minutes <= end); // overnight window
  if (within) return { allowed: true };
  return { allowed: false, hhmm, window: `${user.login_start}–${user.login_end}` };
}

/**
 * Add `days` (may be negative) to an ISO 'YYYY-MM-DD' date, returning ISO. Portable across both
 * dialects (the arithmetic is done in JS, never in SQL). Lives here with the other date helpers
 * because three services had grown their own identical copy.
 */
export function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * חותמת שמירה כפי שמשתמש בישראל קורא אותה: `created_at` נשמר ב-**UTC** בשני הניבים
 * (SQLite `strftime('now')`, Postgres `to_char(now(), …)` על חיבור שה-timezone שלו UTC),
 * ולכן הצגתו כמות שהיא מזיזה כל שעת פעולה בשעתיים-שלוש אחורה — ובדיוק בשדה שנועד לענות על
 * "מתי זה הוזן".
 *
 * @param {string|null|undefined} stored  'YYYY-MM-DD HH:MM:SS' (או ISO) ב-UTC
 * @returns {string} 'DD/MM/YY HH:MM' בשעון ישראל, או '' אם אין ערך/לא נפרס
 */
export function israelStamp(stored) {
  const s = String(stored ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)));
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jerusalem',
      year: '2-digit', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d).map((x) => [x.type, x.value]),
  );
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}
