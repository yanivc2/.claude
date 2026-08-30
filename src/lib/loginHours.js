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
