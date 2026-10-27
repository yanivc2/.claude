// 🔔 פעמון לסוכן הבנק שבמחשב המשרד (בעלים 27/10: "כפתור רק אצלי שאוכל להעיר את הסוכן").
//
// למה פעמון: מחשב המשרד לא מקבל שום חיבור מבחוץ (ובצדק — הוא מחזיק את סיסמאות הבנק), ולכן
// האפליקציה לא יכולה לפנות אליו. הסוכן הוא ששואל "יש סנכרון?", ומחוץ לשעות הפעילות רק פעם ב-30
// דקות — כל שאלה היא הפעלה ב-Vercel ומעירה את מסד הנתונים. הפעמון עוקף את זה בלי לשלם על זה:
// הסוכן מחזיק קו פתוח ושקט לנושא פרטי ב-ntfy (שירות פעמונים פתוח וחינמי), וכשהבעלים לוחץ
// "🔄 סנכרן עכשיו" השרת מצלצל, והסוכן שואל מיד.
//
// 🔴 בצלצול עובר רק המילה "wake" — שום נתון, שום סוד. שם הנושא נגזר מסוד הסוכן ב-HMAC, כך שהוא
// לא חושף את הסוד, ושני הצדדים מחשבים אותו לבד בלי הגדרה נוספת. מי שינחש אותו יכול לכל היותר
// לגרום לסוכן לשאול "יש סנכרון?" — והתשובה תהיה "לא". הקובץ טהור (בלי config) כי גם הסוכן מייבא
// אותו (`agent/bank-agent.mjs`).

import { createHmac } from 'node:crypto';

export const BELL_SERVER = 'https://ntfy.sh';
const TOPIC_LABEL = 'ap-control agent bell v1';

/** שם הנושא הפרטי — אותו ערך בשרת ובסוכן, כי שניהם מחזיקים את אותו סוד. בלי סוד אין פעמון. */
export function bellTopic(secret) {
  if (!secret) return null;
  return `apc-${createHmac('sha256', String(secret)).update(TOPIC_LABEL).digest('hex').slice(0, 32)}`;
}

let transport = (url, init) => fetch(url, init);
/** לבדיקות בלבד: מחליף את fetch. בלי ארגומנט — חוזר ל-fetch האמיתי. */
export function _setBellTransport(fn) {
  transport = fn || ((url, init) => fetch(url, init));
}

/**
 * מצלצל. לעולם לא זורק ולא תוקע: עד 3 שניות, ואם נכשל — הבקשה עדיין קיימת והסוכן יאסוף אותה
 * בבדיקה הקבועה הבאה. `Cache: no` = ntfy לא שומר את ההודעה; היא מגיעה רק למי שמאזין עכשיו.
 */
export async function ringAgentBell({ secret, server = BELL_SERVER, timeoutMs = 3000 } = {}) {
  const topic = bellTopic(secret);
  if (!topic) return { ok: false, reason: 'no-secret' };
  try {
    const res = await transport(`${String(server).replace(/\/+$/, '')}/${topic}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Cache: 'no', Firebase: 'no' },
      body: 'wake',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res && res.ok ? { ok: true } : { ok: false, reason: `http-${res?.status ?? '?'}` };
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/**
 * הסוכן קורא את הזרם של ntfy (שורת JSON לכל אירוע: open / keepalive / message). מחזיר כמה
 * צלצולים היו בשורות השלמות, ואת השארית (שורה שעוד לא נגמרה) לחיבור עם החתיכה הבאה.
 */
export function parseBellStream(buffer) {
  const lines = String(buffer).split('\n');
  const rest = lines.pop();
  let rings = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      if (JSON.parse(line).event === 'message') rings += 1;
    } catch { /* שורה פגומה — מתעלמים */ }
  }
  return { rings, rest };
}
