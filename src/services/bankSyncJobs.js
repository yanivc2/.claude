// 🏦 תור סנכרון הבנק — הגשר בין האפליקציה (Vercel) לסוכן שרץ על מחשב המשרד.
//
// למה תור ולא קריאה ישירה: הפורטל העסקי של הפועלים דורש קוד SMS בכל התחברות, והסריקה צריכה
// דפדפן אמיתי וסשן שנשאר חי מההתחברות, דרך ההמתנה לקוד, ועד המשיכה — כמה דקות רצופות. לפונקציה
// של Vercel אין דפדפן, יש לה תקרת זמן, והיא לא זוכרת כלום בין בקשה לבקשה. לכן הדפדפן רץ על מחשב
// המשרד, והמסד הוא הדבר היחיד ששני הצדדים רואים:
//
//   משתמש לוחץ "סנכרן"  → requested
//   הסוכן תופס          → running        (מתחבר לבנק עם הפרטים שיושבים **אצלו בלבד**)
//   הבנק שלח SMS        → awaiting_otp   (האפליקציה מציגה שדה קוד)
//   המשתמש הזין קוד     → otp_code נכתב; הסוכן לוקח אותו ו**מוחק** → running
//   המשיכה הסתיימה      → done / failed
//
// 🔴 אין כאן שום סיסמת בנק. `login_key` הוא שם המשתמש באפליקציה; הסוכן ממפה אותו לפרטי הבנק
// מקובץ מקומי במחשב המשרד. זה אותו עיקרון שהיה מההתחלה: פרטי בנק לעולם לא במסד ולא ב-Vercel.

import { getExecutor, nowTs } from '../db/adapter.js';
import { RuleError, NotFoundError } from '../lib/errors.js';
import { logAction } from './audit.js';
import { getSetting, setSetting } from './appSettings.js';
import { israelClock, israelToday, israelWeekday, israelDayOf } from '../lib/loginHours.js';
import { notify } from '../lib/notify.js';

export const ACTIVE = ['requested', 'running', 'awaiting_otp'];

/**
 * בקשה שלא נתפסה תוך 2 דקות **פוקעת** ואינה נתפסת אחר כך. אחרת: מחשב המשרד כבוי, מישהו לוחץ,
 * הולך הביתה — ובבוקר המחשב נדלק, תופס את הבקשה, והבנק שולח SMS לאדם שלא מצפה לו ולא ליד המסך.
 */
export const CLAIM_WINDOW_SEC = 120;
/** כמה זמן ממתינים לקוד. קוד SMS של בנק תקף דקות ספורות ממילא. */
export const OTP_WAIT_SEC = 300;
/** ריצה שלא דיווחה זמן כזה נחשבת מתה — הסוכן קרס או שהמחשב נכבה באמצע. */
export const STALE_SEC = 360;
/** מחשב המשרד נחשב "מחובר" אם דיווח לאחרונה בחלון הזה. */
export const AGENT_ONLINE_SEC = 75; // הסוכן שואל כל 30 שניות — מרווח לשתי החמצות

const HEARTBEAT_KEY = 'bank_agent_heartbeat';

/**
 * 🌙 מצב חיסכון של הסוכן: מחוץ לשעות הפעילות הוא שואל "יש סנכרון?" רק פעם ב-N דקות
 * (`agent/bank-agent.mjs#agentSchedule`). מכאן שני דברים בצד השרת:
 *  1. **חלון התפיסה מתארך** ל-N דקות + מרווח — אחרת בקשה שנוצרה בלילה הייתה פוקעת אחרי 2 דקות,
 *     לפני שהסוכן בכלל שואל. החלון עדיין חסום (לא "עד הבוקר"), וזה הנימוק של CLAIM_WINDOW_SEC.
 *  2. **הכרטיס אומר "מצב חיסכון — עד N דקות"** במקום "לא מחובר".
 */
async function readHeartbeat(x) {
  const hb = await getSetting(HEARTBEAT_KEY, null, x);
  try { return hb ? JSON.parse(hb) : null; } catch { return null; }
}
const ECONOMY_SLACK_SEC = 90;
function economyEvery(agent) {
  const n = Number(agent?.offEvery);
  return agent?.mode === 'off' && Number.isFinite(n) && n > 0 ? n : 0;
}
/**
 * 🔔 "רק פעמון" (בעלים 27/10: "מספיק לי רק הפעמון, אם תהיה בעיה אני מחובר לקלוד מהסלולרי"): הסוכן לא
 * שואל בעצמו בכלל — רק כשמצלצלים (כל "סנכרן עכשיו") ובשעה שהקו לפעמון עלה. כשהקו נופל הוא חוזר לבד
 * לבדיקה הקבועה ומדווח `mode` אחר, ולכן כאן "רק פעמון" = מה שהוא דיווח אחרון.
 */
export function bellOnly(agent) {
  return agent?.mode === 'bell' && agent?.bell === true;
}
/** כמה זמן בקשה ממתינה לסוכן לפני שהיא פוקעת. */
export function claimWindowSec(agent) {
  const every = economyEvery(agent);
  return every ? Math.max(CLAIM_WINDOW_SEC, every * 60 + ECONOMY_SLACK_SEC) : CLAIM_WINDOW_SEC;
}

// ---------------------------------------------------------------- סוכן ישן מחוץ לשעות
// סוכן בלי מצב חיסכון (הגרסה הישנה, או `offHoursCheckMinutes: 0`) לא שואל בכלל מחוץ לשעות
// הפעילות — בקשה שנוצרה אז הייתה ממתינה 2 דקות ונכשלת ב"לא הגיב", בלי להסביר למה. את השעות
// יודעים מהתווית שהסוכן עצמו שולח בכל פנייה ("א׳–ה׳ 08:00-16:00", `agent/bank-agent.mjs#activeHours`),
// ולכן אפשר לומר מראש שהבקשה לא תיאסף — ולמה.
const DAY_LETTERS = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']; // 0 = ראשון, כמו בסוכן
function israelDayMinutes(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}
/** האם עכשיו מחוץ לשעות שבתווית. `null` = אין תווית או שאי אפשר לפענח אותה (ואז לא מנחשים). */
export function outsideAgentHours(label, now = new Date()) {
  const s = String(label || '').replace(/[׳']/g, '').trim();
  if (!s) return null;
  const TIME = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/;
  const tm = s.match(TIME);
  const dayPart = s.replace(TIME, '').replace(/\s+/g, '').replace(/–/g, '-');
  let days = null;
  if (dayPart) {
    days = new Set();
    for (const part of dayPart.split(',')) {
      const m = part.match(/^([א-ת])(?:-([א-ת]))?$/);
      const a = m ? DAY_LETTERS.indexOf(m[1]) : -1;
      const b = m ? (m[2] ? DAY_LETTERS.indexOf(m[2]) : a) : -1;
      if (a < 0 || b < a) return null;
      for (let d = a; d <= b; d += 1) days.add(d);
    }
  }
  const { day, minutes } = israelDayMinutes(now);
  if (days && !days.has(day)) return true;
  if (!tm) return false;
  const from = Number(tm[1]) * 60 + Number(tm[2]);
  const to = Number(tm[3]) * 60 + Number(tm[4]);
  const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
  return !inside;
}
/**
 * הסוכן לא יאסוף בקשה עכשיו: לא מחובר, לא במצב חיסכון, ועכשיו מחוץ לשעות שהוא עצמו דיווח.
 * `legacy` = גרסה ישנה (פנייה בלי `mode` בכלל) — מה שמתקן אותה הוא עדכון הקובץ במחשב המשרד.
 */
export function agentAsleep(agent, now = new Date()) {
  if (!agent || economyEvery(agent) || bellOnly(agent)) return null; // 🔔 פעמון מעיר אותו בכל שעה
  if (ageSec(agent.at) <= AGENT_ONLINE_SEC) return null;
  if (outsideAgentHours(agent.hours, now) !== true) return null;
  return { hours: agent.hours, legacy: !agent.mode };
}
export function asleepMessage(asleep) {
  const why = asleep.legacy
    ? 'הסוכן במחשב המשרד הוא הגרסה הישנה, שלא בודקת בקשות אחרי השעות. כדי לסנכרן גם בערב — עדכן את הקובץ bank-agent.mjs במחשב המשרד (מצב חיסכון).'
    : 'הסוכן מוגדר בלי בדיקה אחרי השעות (offHoursCheckMinutes: 0 ב-config.json).';
  return `עכשיו מחוץ לשעות הפעילות של הסוכן (${asleep.hours}, שעון ישראל), ולכן הבקשה לא תיאסף. ${why} אחרת — נסה שוב בשעות הפעילות.`;
}

function ageSec(ts) {
  if (!ts) return Infinity;
  const t = Date.parse(`${String(ts).replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? (Date.now() - t) / 1000 : Infinity;
}

/** 🔴 probe (ראה CLAUDE.md): בלעדיו "אין טבלה" נראה כמו "אין סנכרונים" ולא כמו "צריך לעדכן מסד". */
export async function bankSyncReady(x = getExecutor()) {
  try {
    await x.many('SELECT id FROM bank_sync_jobs LIMIT 1', []);
    return true;
  } catch {
    return false;
  }
}

/** המפתח שהסוכן מחפש בקובץ הפרטים שלו. לא סוד — שם משתמש באפליקציה. */
export function loginKeyFor(user) {
  return String(user?.username || user?.email || `user-${user?.id}`).trim();
}

/** 6 ספרות בדרך כלל; מקבלים 4–10 ומסירים רווחים/מקפים שנדבקים בהעתקה מהודעה. */
export function normalizeOtp(raw) {
  const s = String(raw ?? '').replace(/[\s-]/g, '');
  return /^\d{4,10}$/.test(s) ? s : null;
}

/**
 * מסמן בקשות שפג זמנן. רץ בתחילת כל פעולה, כך שאין צורך בקרון נפרד.
 * החישוב ב-JS ולא ב-SQL: חשבון תאריכים שונה בין SQLite ל-Postgres, ויש כאן לכל היותר שורה או שתיים.
 */
async function expireStale(x) {
  const agent = await readHeartbeat(x);
  const windowSec = claimWindowSec(agent);
  const rows = await x.many(
    `SELECT id, status, updated_at, requested_at FROM bank_sync_jobs WHERE status IN (?, ?, ?)`,
    ACTIVE,
  );
  for (const r of rows) {
    let next = null;
    let msg = null;
    if (r.status === 'requested' && ageSec(r.requested_at) > windowSec) {
      next = 'expired';
      // 🔔 ברק-פעמון הסוכן אמור לקום תוך שניות — אם לא קם, זו תקלה ולא "עוד מעט": אומרים מה לבדוק.
      msg = bellOnly(agent)
        ? `מחשב המשרד לא התעורר תוך ${Math.round(windowSec / 60)} דקות — כנראה חלון הסוכן סגור, המחשב כבוי, או שהקו לפעמון נפל. בדוק שחלון הסוכן פתוח במחשב המשרד, או כתוב ל-Claude.`
        : `מחשב המשרד לא הגיב תוך ${Math.round(windowSec / 60)} דקות. ודא שהוא דלוק ושהסוכן רץ, ולחץ שוב.`;
    } else if (r.status === 'awaiting_otp' && ageSec(r.updated_at) > OTP_WAIT_SEC) {
      next = 'failed';
      msg = 'לא הוזן קוד SMS בזמן. לחץ "סנכרן" שוב כדי לקבל קוד חדש.';
    } else if (r.status === 'running' && ageSec(r.updated_at) > STALE_SEC) {
      next = 'failed';
      msg = 'מחשב המשרד הפסיק לדווח באמצע הסנכרון.';
    }
    if (next) {
      const u = await x.run(
        `UPDATE bank_sync_jobs SET status = ?, message = ?, otp_code = NULL, updated_at = ?, finished_at = ?
          WHERE id = ? AND status = ?`,
        [next, msg, nowTs(), nowTs(), r.id, r.status],
      );
      // בקשה שאף אחד לא אסף = הבעלים צריך לדעת מיד (פעם אחת — רק מי שביצע את המעבר מתריע).
      if (next === 'expired' && u.changes) {
        await notify(`⚠️ <b>סנכרון בנק: מחשב המשרד לא הגיב</b>\n${msg}`, { kind: 'bank', link: '/reconciliation#bank-sync' });
      }
    }
  }
}

async function getJob(id, x) {
  const job = await x.one('SELECT * FROM bank_sync_jobs WHERE id = ?', [Number(id)]);
  if (!job) throw new NotFoundError(`בקשת סנכרון ${id} לא נמצאה`);
  return job;
}

// ---------------------------------------------------------------- צד המשתמש (האפליקציה)

/**
 * "סנכרן עכשיו". בקשה פעילה אחת בכל רגע — שתי התחברויות מקבילות לאותו בנק הן בדיוק מה שמפעיל
 * את מנגנוני ההונאה שלו, ושתי הודעות SMS בבת אחת מבלבלות את מי שצריך להקליד אחת מהן.
 */
async function waitingMessage(x) {
  const every = economyEvery(await readHeartbeat(x));
  return every
    ? `ממתין למחשב המשרד — מצב חיסכון, הבקשה תיאסף תוך עד ${every} דקות ואז יגיע קוד SMS…`
    : 'ממתין למחשב המשרד…';
}

// 🔔 `ring` (כל מי שלוחץ — routes/reconciliation.js, lib/agentBell.js): מצלצל לסוכן אחרי שהבקשה נשמרה,
// כדי שישאל מיד ולא בבדיקה הקבועה הבאה. סוכן שדיווח שהוא מאזין לפעמון (`bell` בפעימה) לא "ישן"
// בשביל מי שמצלצל — הכפתור לא ננעל, וההודעה אומרת "מעיר". צלצול שנכשל לא מכשיל כלום: הבקשה
// נשארת, וההודעה חוזרת לזמן ההמתנה הרגיל.
const WAKING_MSG = '🔔 מעיר את מחשב המשרד — הבקשה תיאסף תוך שניות, ואז יגיע קוד SMS…';
export async function requestSync(user, x = getExecutor(), { ring = null } = {}) {
  if (!(await bankSyncReady(x))) {
    throw new RuleError('BANK_SYNC', 'נדרש עדכון מסד נתונים (הגדרות ← "עדכן מסד נתונים") לפני סנכרון בנק.');
  }
  await expireStale(x);
  const active = await x.one(
    `SELECT j.id, u.name AS by_name FROM bank_sync_jobs j LEFT JOIN users u ON u.id = j.requested_by
      WHERE j.status IN (?, ?, ?) ORDER BY j.id DESC LIMIT 1`,
    ACTIVE,
  );
  if (active) {
    throw new RuleError('BANK_SYNC', `סנכרון כבר מתבצע${active.by_name ? ` (התחיל: ${active.by_name})` : ''} — המתן לסיומו.`);
  }
  // נכשל מראש ובהסבר, במקום בקשה שממתינה 2 דקות ונכשלת ב"לא הגיב".
  const agent = await readHeartbeat(x);
  const wakes = typeof ring === 'function' && agent?.bell === true;
  const asleep = wakes ? null : agentAsleep(agent);
  if (asleep) throw new RuleError('BANK_SYNC', asleepMessage(asleep));
  const ts = nowTs();
  const info = await x.run(
    `INSERT INTO bank_sync_jobs (status, login_key, requested_by, requested_at, updated_at, message)
     VALUES ('requested', ?, ?, ?, ?, ?)`,
    [loginKeyFor(user), user?.id ?? null, ts, ts, wakes ? WAKING_MSG : await waitingMessage(x)],
  );
  const id = info.lastInsertRowid;
  let bell = null;
  if (typeof ring === 'function') {
    bell = await ring().catch(() => ({ ok: false, reason: 'error' }));
    if (wakes && !bell?.ok) {
      await x.run(`UPDATE bank_sync_jobs SET message = ? WHERE id = ? AND status = 'requested' AND message = ?`,
        [await waitingMessage(x), id, WAKING_MSG]);
    }
  }
  await logAction(
    {
      userId: user?.id ?? null, action: 'bank_sync.request', entityType: 'bank_sync_job', entityId: id,
      details: bell ? { bell: bell.ok ? 'rang' : `failed:${bell.reason || '?'}` } : null,
    },
    x,
  );
  return getJob(id, x);
}

/**
 * הקוד שהגיע ב-SMS. 🔴 רק מי שביקש (או הבעלים): ה-SMS נשלח לטלפון של בעל פרטי הבנק שבהם
 * משתמשים — כלומר של מי שלחץ. הקוד עצמו **לעולם לא נרשם ביומן** — רק העובדה שהוזן.
 */
export async function submitOtp(id, rawCode, user, x = getExecutor()) {
  const code = normalizeOtp(rawCode);
  if (!code) throw new RuleError('BANK_SYNC', 'הקוד צריך להיות ספרות בלבד (בדרך כלל 6).');
  await expireStale(x);
  const job = await getJob(id, x);
  if (Number(job.requested_by) !== Number(user?.id) && user?.role !== 'owner') {
    throw new RuleError('BANK_SYNC', 'רק מי שהתחיל את הסנכרון יכול להזין את הקוד — ה-SMS נשלח לטלפון שלו.');
  }
  if (job.status !== 'awaiting_otp') {
    throw new RuleError('BANK_SYNC', 'הסנכרון כבר לא ממתין לקוד (אולי פג הזמן). לחץ "סנכרן" שוב.');
  }
  const r = await x.run(
    `UPDATE bank_sync_jobs SET otp_code = ?, message = ?, updated_at = ? WHERE id = ? AND status = 'awaiting_otp'`,
    [code, 'הקוד התקבל — מאמת מול הבנק…', nowTs(), job.id],
  );
  if (!r.changes) throw new RuleError('BANK_SYNC', 'הסנכרון כבר לא ממתין לקוד. לחץ "סנכרן" שוב.');
  await logAction(
    { userId: user?.id ?? null, action: 'bank_sync.otp', entityType: 'bank_sync_job', entityId: job.id },
    x,
  );
  return { ok: true };
}

/** ביטול. הסוכן רואה אותו בבדיקה הבאה וסוגר את הדפדפן. */
export async function cancelSync(id, user, x = getExecutor()) {
  const job = await getJob(id, x);
  if (Number(job.requested_by) !== Number(user?.id) && user?.role !== 'owner') {
    throw new RuleError('BANK_SYNC', 'רק מי שהתחיל את הסנכרון או הבעלים יכולים לבטל אותו.');
  }
  await x.run(
    `UPDATE bank_sync_jobs SET status = 'cancelled', otp_code = NULL, message = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND status IN (?, ?, ?)`,
    ['בוטל.', nowTs(), nowTs(), job.id, ...ACTIVE],
  );
  return { ok: true };
}

/**
 * מה להציג בכרטיס. 🔴 התוצאה מסוננת לסקופ של הצופה: סנכרון אחד מושך את כל החשבונות שפרטי הבנק
 * רואים, ומשתמשת עם הרשאה לחנות אחת לא אמורה לראות את מספרי החשבונות והסכומים של חנות אחרת.
 */
export async function syncStatus(user, scope = null, x = getExecutor()) {
  const ready = await bankSyncReady(x);
  const agent = await readHeartbeat(x);
  const agentAge = ageSec(agent?.at);
  const every = economyEvery(agent);
  const base = {
    ready,
    agentOnline: !every && agentAge <= AGENT_ONLINE_SEC,
    // מצב חיסכון: הסוכן חי (שאל בתוך N דקות + מרווח) ובודק פעם ב-N דקות.
    agentEconomy: every > 0 && agentAge <= every * 60 + ECONOMY_SLACK_SEC,
    agentOffEvery: every || null,
    agentSeenSec: Number.isFinite(agentAge) ? Math.round(agentAge) : null,
    agentHours: agent?.hours || null,
    // 🔔 הסוכן מאזין לפעמון — "סנכרן עכשיו" (של כל אחד) מעיר אותו מיד.
    agentBell: agent?.bell === true,
    // 🔔 רק פעמון: הסוכן לא שואל בעצמו, ולכן "נראה לאחרונה" אינו מדד חיים — אל תציג "לא מחובר".
    agentBellOnly: bellOnly(agent),
    // הסוכן לא יאסוף בקשה עכשיו (מחוץ לשעות, בלי מצב חיסכון) — הכרטיס אומר זאת במקום כפתור שנכשל.
    // סוכן שמאזין לפעמון לא נחסם: הצלצול מעיר גם סוכן שלא בודק בכלל מחוץ לשעות.
    agentAsleepMsg: (() => {
      if (agent?.bell === true) return null;
      const a = agentAsleep(agent);
      return a ? asleepMessage(a) : null;
    })(),
    loginKey: loginKeyFor(user),
    job: null,
  };
  if (!ready) return base;

  await expireStale(x);
  // בקשה פעילה, או האחרונה שהסתיימה בחצי השעה האחרונה — כדי שהתוצאה תישאר על המסך אחרי הסיום.
  const job = await x.one(
    `SELECT j.*, u.name AS by_name FROM bank_sync_jobs j LEFT JOIN users u ON u.id = j.requested_by
      ORDER BY j.id DESC LIMIT 1`,
    [],
  );
  if (!job) return base;
  const finishedLongAgo = !ACTIVE.includes(job.status) && ageSec(job.finished_at || job.updated_at) > 1800;
  if (finishedLongAgo) return base;

  const mine = Number(job.requested_by) === Number(user?.id);
  let result = null;
  if (job.result) {
    try {
      const r = JSON.parse(job.result);
      const allowed = scope?.storeIds == null ? null : new Set(scope.storeIds.map(Number));
      const accounts = (r.accounts || []).filter((a) => !allowed || allowed.has(Number(a.storeId)));
      result = {
        accounts,
        inserted: accounts.reduce((n, a) => n + (a.inserted || 0), 0),
        matched: accounts.reduce((n, a) => n + (a.matched || 0), 0),
        // מספרי חשבון לא מזוהים — רק כמות לכולם; רשימה (מוסתרת חלקית) רק לבעלים.
        unmappedCount: (r.unmapped || []).length,
        unmapped: user?.role === 'owner' ? (r.unmapped || []) : [],
      };
    } catch { result = null; }
  }
  // 🔴 בזמן עבודה הסוכן לא שואל "יש עבודה?" — הוא מחכה לבנק או לקליטה בשרת (עשרות שניות), ופעימת
  // החיים מתיישנת. הכרטיס הציג "מחשב המשרד לא מחובר" באמצע סנכרון תקין (נצפה). בקשה שנתפסה ועדיין
  // פעילה היא עצמה הוכחת חיים — ובקשה שהסוכן נטש פוקעת ב-expireStale.
  const working = job.agent && ['running', 'awaiting_otp'].includes(job.status);
  return {
    ...base,
    agentOnline: base.agentOnline || Boolean(working),
    job: {
      id: job.id,
      status: job.status,
      message: job.message,
      requestedAt: job.requested_at,
      finishedAt: job.finished_at,
      byName: job.by_name || null,
      mine,
      canEnterOtp: job.status === 'awaiting_otp' && (mine || user?.role === 'owner'),
      canCancel: ACTIVE.includes(job.status) && (mine || user?.role === 'owner'),
      result,
    },
  };
}

// ---------------------------------------------------------------- צד הסוכן (מחשב המשרד)

/** פעימת חיים — כותבים רק אם הקודמת ישנה מ-20 שניות, כדי לא לכתוב למסד בכל בדיקה. */
async function heartbeat(agentName, x, hours = undefined, meta = {}) {
  const prev = await readHeartbeat(x);
  // שעות הפעילות של הסוכן (למשל "08:00-16:00") — מחוץ להן הוא לא שולח אף בקשה, והכרטיס אומר את זה
  // במקום "לא מחובר" סתמי. `undefined` = הפנייה לא מסרה שעות, נשארים עם הידוע.
  const h = hours === undefined ? (prev?.hours ?? null) : (/^[א-ת׳,–\- ]{0,24}(\d{2}:\d{2}-\d{2}:\d{2})?$/.test(String(hours || '')) && /\S/.test(String(hours || '')) ? String(hours).trim() : null);
  // מצב ומרווח החיסכון — רק ערכים מוכרים נשמרים (הגוף מגיע מהסוכן, לא סומכים עליו עיוור).
  const mode = ['off', 'on', 'bell'].includes(meta.mode) ? meta.mode : (prev?.mode ?? null);
  const n = Number(meta.offEvery);
  const offEvery = meta.offEvery === undefined ? (prev?.offEvery ?? null) : (Number.isFinite(n) && n >= 2 && n <= 120 ? Math.round(n) : null);
  // 🔔 הסוכן מאזין לפעמון עכשיו (lib/agentBell.js) — רק claim מוסר את זה; פנייה אחרת נשארת עם הידוע.
  const bell = meta.bell === undefined ? (prev?.bell ?? null) : (meta.bell === true ? true : null);
  if (!prev || ageSec(prev.at) > 20 || prev.agent !== agentName || (prev.hours ?? null) !== h
      || (prev.mode ?? null) !== mode || (prev.offEvery ?? null) !== offEvery || (prev.bell ?? null) !== bell) {
    await setSetting(HEARTBEAT_KEY, JSON.stringify({ at: nowTs(), agent: agentName, hours: h, mode, offEvery, bell }), x);
  }
}

/** בדיקת חיבור מהסוכן (npm run check במחשב המשרד): רק פעימת חיים, בלי לתפוס בקשה. */
export async function agentPing(agentName, x = getExecutor(), { hours, offEvery } = {}) {
  await heartbeat(agentName, x, hours, { offEvery });
  return { ok: true, ready: await bankSyncReady(x) };
}

/**
 * הסוכן שואל "יש עבודה?". 🔴 התפיסה אטומית (`UPDATE … WHERE status='requested'` ובדיקת
 * `changes`): שני סוכנים שרצים בטעות על שני מחשבים לא יתפסו את אותה בקשה — כלומר לא יתחברו
 * לבנק פעמיים במקביל.
 */
export async function claimNext(agentName, x = getExecutor(), { hours, mode, offEvery, bell } = {}) {
  // סוכן ישן (בלי פעמון) לא שולח `bell` — וזה אומר "לא מאזין", לא "לא ידוע".
  await heartbeat(agentName, x, hours, { mode, offEvery, bell: bell === true });
  await expireStale(x);
  const busy = await x.one(`SELECT id FROM bank_sync_jobs WHERE status IN (?, ?) LIMIT 1`, ['running', 'awaiting_otp']);
  if (busy) return null; // אחד בכל פעם
  const job = await x.one(
    `SELECT id, login_key, requested_at FROM bank_sync_jobs WHERE status = 'requested' ORDER BY id LIMIT 1`,
    [],
  );
  if (!job) return null;
  const r = await x.run(
    `UPDATE bank_sync_jobs SET status = 'running', agent = ?, message = ?, updated_at = ?
      WHERE id = ? AND status = 'requested'`,
    [String(agentName || '?').slice(0, 80), 'מתחבר לבנק…', nowTs(), job.id],
  );
  if (!r.changes) return null;
  // 🔴 רק החשבונות הרשומים באפליקציה נקראים מהבנק. הפורטל מציג גם חשבונות שאינם של העסק (נמדד:
  // 7 בבנק מול 4 באפליקציה), והבעלים לא רוצה שהם ייקראו בכלל — לא רק שלא ייקלטו. הרשימה נשלפת
  // בכל תפיסה, ולכן חשבון שנוסף בהגדרות נכלל מהסנכרון הבא. ספרות בלבד: סניף + מספר חשבון.
  const accounts = (await x.many('SELECT branch, account_number FROM bank_accounts', []))
    .map((a) => ({ branch: String(a.branch ?? '').replace(/\D/g, ''), account_number: String(a.account_number ?? '').replace(/\D/g, '') }))
    .filter((a) => a.account_number);
  return { id: job.id, loginKey: job.login_key, requestedAt: job.requested_at, accounts };
}

async function agentJob(id, agentName, x) {
  await heartbeat(agentName, x); // כל פנייה של הסוכן היא סימן חיים, לא רק "יש עבודה?"
  const job = await getJob(id, x);
  if (job.agent && agentName && job.agent !== String(agentName).slice(0, 80)) {
    throw new RuleError('BANK_SYNC', 'הבקשה נתפסה על ידי סוכן אחר');
  }
  return job;
}

/** הסוכן מדווח התקדמות. מחזיר `cancelled` אם המשתמש ביטל, כדי שהסוכן יפסיק. */
export async function reportState(id, { status, message }, agentName, x = getExecutor()) {
  await expireStale(x);
  const job = await agentJob(id, agentName, x);
  if (!ACTIVE.includes(job.status)) return { cancelled: true, status: job.status };
  if (!['running', 'awaiting_otp', 'failed'].includes(status)) {
    throw new RuleError('BANK_SYNC', `מצב לא מוכר מהסוכן: ${status}`);
  }
  const msg = String(message || '').slice(0, 500) || null;
  // 🔴 רק לקיחת הקוד (takeOtp) מוציאה בקשה ממצב "ממתין לקוד". דיווח "עובד…" שהגיע באיחור —
  // בקשות HTTP לא מובטחות להגיע לפי הסדר — היה מעלים את שדה הקוד בדיוק כשה-SMS מגיע.
  if (job.status === 'awaiting_otp' && status === 'running') return { ok: true, ignored: true };
  if (status === 'failed') {
    await x.run(
      `UPDATE bank_sync_jobs SET status = 'failed', otp_code = NULL, message = ?, updated_at = ?, finished_at = ? WHERE id = ?`,
      [msg || 'הסנכרון נכשל.', nowTs(), nowTs(), job.id],
    );
    return { ok: true };
  }
  await x.run(
    // מעבר ל-awaiting_otp מאפס קוד ישן: קוד שהוזן לבקשה קודמת אסור שייכנס לחלון הזה.
    `UPDATE bank_sync_jobs SET status = ?, message = ?, updated_at = ?${status === 'awaiting_otp' ? ', otp_code = NULL' : ''} WHERE id = ?`,
    [status, msg || (status === 'awaiting_otp' ? 'הבנק שלח קוד SMS — הזן אותו כאן.' : 'עובד…'), nowTs(), job.id],
  );
  return { ok: true };
}

/**
 * הסוכן לוקח את הקוד. 🔴 קריאה-ומחיקה אטומית: הקוד יוצא מהמסד ברגע שנלקח
 * (`UPDATE … WHERE otp_code = ?` ובדיקת `changes`), כך שהוא קיים במסד לכל היותר שניות ולעולם
 * לא נמסר פעמיים.
 */
export async function takeOtp(id, agentName, x = getExecutor()) {
  await expireStale(x);
  const job = await agentJob(id, agentName, x);
  if (!ACTIVE.includes(job.status)) return { cancelled: true, status: job.status, message: job.message };
  if (!job.otp_code) return { otp: null };
  const r = await x.run(
    `UPDATE bank_sync_jobs SET otp_code = NULL, status = 'running', message = ?, updated_at = ?
      WHERE id = ? AND otp_code = ?`,
    ['מאמת את הקוד מול הבנק…', nowTs(), job.id, job.otp_code],
  );
  return r.changes ? { otp: job.otp_code } : { otp: null };
}

/**
 * הסוכן מסיים. התנועות נקלטות דרך `importScrapedBatch` — אותו צינור של כל ערוץ בנק אחר (ייבוא ←
 * התאמה אוטומטית ← התראה). ה-actor הוא **מי שביקש**, כך שביומן כתוב מי משך, לא "מערכת".
 */
export async function completeWithAccounts(id, payload, agentName, x = getExecutor()) {
  const job = await agentJob(id, agentName, x);
  if (!ACTIVE.includes(job.status)) return { cancelled: true, status: job.status };
  const actor = job.requested_by
    ? await x.one('SELECT * FROM users WHERE id = ?', [job.requested_by])
    : null;

  const { importScrapedBatch } = await import('./bankSync.js');
  const r = await importScrapedBatch(payload, actor || null, x);
  await reportCheckProbe(payload?.probe, x);

  // storeId לכל חשבון — כדי שהכרטיס יוכל לסנן לפי הסקופ של הצופה (ראה syncStatus).
  const accounts = [];
  for (const a of r.results || []) {
    const ba = await x.one('SELECT store_id FROM bank_accounts WHERE id = ?', [a.accountId]);
    accounts.push({
      accountId: a.accountId,
      storeId: ba?.store_id ?? null,
      displayName: a.displayName,
      inserted: a.inserted,
      skipped: a.skipped,
      matched: a.matched,
    });
  }
  // מספר חשבון לא מזוהה נשמר מוסתר: 4 הספרות האחרונות מספיקות כדי לזהות אותו, לא יותר.
  const unmapped = (r.unmapped || []).map((n) => {
    const d = String(n).replace(/\D/g, '');
    return d.length > 4 ? `…${d.slice(-4)}` : d;
  });
  const summary = { accounts, unmapped };
  const inserted = accounts.reduce((n, a) => n + (a.inserted || 0), 0);
  const msg = `הסנכרון הושלם: ${inserted} תנועות חדשות ב-${accounts.length} חשבונות`
    + (unmapped.length ? `, ${unmapped.length} חשבונות לא מזוהים.` : '.');
  await x.run(
    `UPDATE bank_sync_jobs SET status = 'done', otp_code = NULL, result = ?, message = ?, updated_at = ?, finished_at = ?
      WHERE id = ?`,
    [JSON.stringify(summary), msg, nowTs(), nowTs(), job.id],
  );
  await logAction(
    { userId: job.requested_by ?? null, action: 'bank_sync.done', entityType: 'bank_sync_job', entityId: job.id,
      details: { accounts: accounts.length, inserted, unmapped: unmapped.length } },
    x,
  );
  return { ok: true, summary };
}

/**
 * תזכורת סנכרון יומית — בעלים 20/10 ("תזכורת יומית לסנכרון בנק בשעה קבועה" → 12:00, א׳–ה׳, רק אם עוד לא סונכרן
 * היום). בכל כניסה לבנק נדרש קוד SMS, ולכן הסנכרון לא יכול לרוץ לבד — התזכורת אומרת למי שצריך ללחוץ.
 * נקרא מ-GET /ingest/bank-sync-reminder (Vercel Cron, פעמיים: 09:00 ו-10:00 UTC). 🔴 Vercel מתזמן ב-UTC, וישראל
 * עוברת בין +2 ל-+3: מריצה אחת הייתה זזה ל-11:00 או 13:00 לחצי שנה. לכן שתי ריצות, ונשלח רק בריצה שבה
 * בישראל השעה 12, ופעם אחת ביום (`bank_sync_reminder_day`).
 * "סונכרן היום" = סנכרון שהסתיים בהצלחה היום (שעון ישראל), או סנכרון שרץ עכשיו. סנכרון שנכשל — עדיין מזכירים.
 * @returns {Promise<{sent:boolean, reason?:string}>}
 */
export async function bankSyncReminder({ now = new Date() } = {}, x = getExecutor()) {
  const day = israelToday(now);
  const dow = israelWeekday(now);
  if (dow < 0 || dow > 4) return { sent: false, reason: 'not Sun–Thu in Israel' };
  if (Math.floor(israelClock(now).minutes / 60) !== 12) return { sent: false, reason: 'not 12:00 in Israel' };
  if ((await getSetting('bank_sync_reminder_day', null, x)) === day) return { sent: false, reason: 'already reminded today' };
  let jobs = [];
  try {
    const since = new Date(now.getTime() - 36 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    jobs = await x.many('SELECT status, requested_at, finished_at FROM bank_sync_jobs WHERE requested_at >= ?', [since]);
  } catch {
    jobs = []; // לפני "עדכון מסד נתונים" אין טבלה — הסנכרון ממילא לא עובד, והתזכורת מובילה לדף שאומר זאת
  }
  const syncedToday = jobs.some((j) => (j.status === 'done' && israelDayOf(j.finished_at || j.requested_at) === day)
    || (ACTIVE.includes(j.status) && israelDayOf(j.requested_at) === day));
  if (syncedToday) return { sent: false, reason: 'synced today' };
  await setSetting('bank_sync_reminder_day', day, x);
  await notify('🏦 <b>תזכורת: סנכרון בנק</b>\nהיום עוד לא סונכרן הבנק. בהתאמת בנק ← "🔄 סנכרן עכשיו", ואז הקוד מה-SMS.',
    { kind: 'bank', link: '/reconciliation' });
  return { sent: true };
}

/**
 * בדיקת "צילום צ׳ק מהבנק" (בעלים 20/10): הסוכן מוסר אילו **שמות שדות** הבנק מחזיר בשורת צ׳ק
 * (scraper/hapoalimBiz.js#checkRowKeys — בלי ערכים). פעם אחת, בסנכרון הראשון שיש בו שורת צ׳ק: נשמר ב-app_settings
 * (`bank_check_probe`) ונשלח לבעלים (פעמון + טלגרם), כדי שיעביר — אין לי גישה למסד החי. שם שדה שאינו אותיות/ספרות
 * לטיניות נזרק; לא יותר מ-120 שמות.
 */
export async function reportCheckProbe(probe, x = getExecutor()) {
  const latin = (list) => (Array.isArray(list) ? list.map(String).filter((k) => /^[A-Za-z0-9_.[\]]{1,80}$/.test(k)).slice(0, 120) : []);
  const looksLikeImage = (k) => /image|img|scan|url|link|picture|photo|document|cheque|check/i.test(k);
  let sent = false;
  // שלב 1 — שמות השדות של שורת הצ׳ק עצמה.
  const keys = latin(probe?.keys);
  const checkRows = Number(probe?.checkRows) || 0;
  if (checkRows && keys.length && !(await getSetting('bank_check_probe', null, x))) {
    await setSetting('bank_check_probe', JSON.stringify({ at: nowTs(), checkRows, keys }), x);
    const hint = keys.filter(looksLikeImage);
    await notify(`🔎 <b>בדיקה: צילום צ׳ק מהבנק</b>\nבשורת צ׳ק (${checkRows} שורות בסנכרון) הבנק מחזיר את השדות: ${keys.join(', ')}.`
      + (hint.length ? `\nשדות שאולי מובילים לצילום: ${hint.join(', ')}.` : '\nאין ביניהם שדה שנראה כמו קישור לצילום.')
      + '\nלהעביר את ההודעה הזו ל-Claude.', { kind: 'bank', link: '/reconciliation' });
    sent = true;
  }
  // שלב 2 — "פרטים נוספים" (pfmDetails) של שורת צ׳ק אחת: נתיב הקישור בלי query, ושמות השדות שבתשובה.
  const d = probe?.details;
  if (d && typeof d === 'object' && !(await getSetting('bank_check_probe_details', null, x))) {
    const path = /^\/[A-Za-z0-9/_.-]{1,200}$/.test(String(d.path || '')) ? d.path : null;
    const dkeys = latin(d.keys);
    const error = d.error ? String(d.error).replace(/[^A-Za-z0-9 /_.-]/g, '').slice(0, 80) : null;
    if (dkeys.length || error) {
      await setSetting('bank_check_probe_details', JSON.stringify({ at: nowTs(), path, keys: dkeys, error }), x);
      const hint = dkeys.filter(looksLikeImage);
      await notify(`🔎 <b>בדיקה (שלב 2): פרטי שורת צ׳ק</b>\nהקישור: ${path || '(לא נתיב פשוט)'}`
        + (error ? `\n${/^no link/.test(error) ? 'בשורות הצ׳ק לא נמצא קישור לפרטים' : 'הקריאה לא הצליחה'}: ${error}.` : `\nהבנק מחזיר בפרטים את השדות: ${dkeys.join(', ')}.`)
        + (hint.length ? `\nשדות שאולי מובילים לצילום: ${hint.join(', ')}.` : '')
        + '\nלהעביר את ההודעה הזו ל-Claude.', { kind: 'bank', link: '/reconciliation' });
      sent = true;
    }
  }
  return sent;
}
