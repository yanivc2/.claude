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
export const AGENT_ONLINE_SEC = 45;

const HEARTBEAT_KEY = 'bank_agent_heartbeat';

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
  const rows = await x.many(
    `SELECT id, status, updated_at, requested_at FROM bank_sync_jobs WHERE status IN (?, ?, ?)`,
    ACTIVE,
  );
  for (const r of rows) {
    let next = null;
    let msg = null;
    if (r.status === 'requested' && ageSec(r.requested_at) > CLAIM_WINDOW_SEC) {
      next = 'expired';
      msg = 'מחשב המשרד לא הגיב תוך 2 דקות. ודא שהוא דלוק ושהסוכן רץ, ולחץ שוב.';
    } else if (r.status === 'awaiting_otp' && ageSec(r.updated_at) > OTP_WAIT_SEC) {
      next = 'failed';
      msg = 'לא הוזן קוד SMS בזמן. לחץ "סנכרן" שוב כדי לקבל קוד חדש.';
    } else if (r.status === 'running' && ageSec(r.updated_at) > STALE_SEC) {
      next = 'failed';
      msg = 'מחשב המשרד הפסיק לדווח באמצע הסנכרון.';
    }
    if (next) {
      await x.run(
        `UPDATE bank_sync_jobs SET status = ?, message = ?, otp_code = NULL, updated_at = ?, finished_at = ?
          WHERE id = ? AND status = ?`,
        [next, msg, nowTs(), nowTs(), r.id, r.status],
      );
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
export async function requestSync(user, x = getExecutor()) {
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
  const ts = nowTs();
  const info = await x.run(
    `INSERT INTO bank_sync_jobs (status, login_key, requested_by, requested_at, updated_at, message)
     VALUES ('requested', ?, ?, ?, ?, ?)`,
    [loginKeyFor(user), user?.id ?? null, ts, ts, 'ממתין למחשב המשרד…'],
  );
  await logAction(
    { userId: user?.id ?? null, action: 'bank_sync.request', entityType: 'bank_sync_job', entityId: info.lastInsertRowid },
    x,
  );
  return getJob(info.lastInsertRowid, x);
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
  const hb = await getSetting(HEARTBEAT_KEY, null, x);
  let agent = null;
  try { agent = hb ? JSON.parse(hb) : null; } catch { agent = null; }
  const agentAge = ageSec(agent?.at);
  const base = {
    ready,
    agentOnline: agentAge <= AGENT_ONLINE_SEC,
    agentSeenSec: Number.isFinite(agentAge) ? Math.round(agentAge) : null,
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
  return {
    ...base,
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
async function heartbeat(agentName, x) {
  const hb = await getSetting(HEARTBEAT_KEY, null, x);
  let prev = null;
  try { prev = hb ? JSON.parse(hb) : null; } catch { prev = null; }
  if (!prev || ageSec(prev.at) > 20 || prev.agent !== agentName) {
    await setSetting(HEARTBEAT_KEY, JSON.stringify({ at: nowTs(), agent: agentName }), x);
  }
}

/** בדיקת חיבור מהסוכן (npm run check במחשב המשרד): רק פעימת חיים, בלי לתפוס בקשה. */
export async function agentPing(agentName, x = getExecutor()) {
  await heartbeat(agentName, x);
  return { ok: true, ready: await bankSyncReady(x) };
}

/**
 * הסוכן שואל "יש עבודה?". 🔴 התפיסה אטומית (`UPDATE … WHERE status='requested'` ובדיקת
 * `changes`): שני סוכנים שרצים בטעות על שני מחשבים לא יתפסו את אותה בקשה — כלומר לא יתחברו
 * לבנק פעמיים במקביל.
 */
export async function claimNext(agentName, x = getExecutor()) {
  await heartbeat(agentName, x);
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
  return { id: job.id, loginKey: job.login_key, requestedAt: job.requested_at };
}

async function agentJob(id, agentName, x) {
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
