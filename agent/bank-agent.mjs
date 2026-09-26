#!/usr/bin/env node
// 🏦 סוכן סנכרון הבנק — רץ על מחשב המשרד.
//
// למה הוא קיים: הפורטל העסקי של הפועלים דורש קוד SMS בכל התחברות, והסריקה צריכה דפדפן אמיתי
// שנשאר פתוח מההתחברות, דרך ההמתנה לקוד, ועד המשיכה. לאפליקציה (Vercel) אין דפדפן. אז הדפדפן
// רץ כאן, והאפליקציה היא רק לוח הבקרה:
//
//   1. מישהו לוחץ "סנכרן" באפליקציה          → הסוכן תופס את הבקשה (בודק כל 10 שניות)
//   2. הסוכן מתחבר לבנק עם הפרטים של מי שלחץ  → הבנק שולח SMS לטלפון שלו
//   3. האפליקציה מציגה לו שדה קוד             → הוא מקליד, הסוכן לוקח את הקוד וממשיך
//   4. התנועות של כל החשבונות נשלחות לאפליקציה → ייבוא + התאמה אוטומטית
//
// 🔴 פרטי הבנק נמצאים **רק** ב-config.json שבתיקייה הזו, על המחשב הזה. הם לא נשלחים לאפליקציה,
// לא נשמרים במסד, ולא נכתבים ללוג — גם לא בהודעות שגיאה (ראה scrub).
//
//   npm install        פעם אחת (מוריד את puppeteer + דפדפן)
//   npm run check      בודק הגדרות, חיבור לאפליקציה, ושהדפדפן עולה — בלי לגעת בבנק
//   npm start          מריץ את הסוכן (להשאיר פתוח)

import os from 'node:os';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BANK_AGENT_CONFIG || path.join(here, 'config.json');
const NAME = os.hostname();
const IDLE_MS = 10_000;     // כל כמה זמן לבדוק אם מישהו לחץ "סנכרן"
const OTP_POLL_MS = 2_000;  // כל כמה זמן לבדוק אם הוזן קוד
const OTP_WAIT_MS = 290_000; // השרת מוותר אחרי 300 שניות — הסוכן מוותר רגע לפניו

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleString('he-IL'), '·', ...a); // eslint-disable-line no-console

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`לא נמצא ${CONFIG_PATH}. העתק את config.example.json ל-config.json ומלא את הפרטים.`);
  }
  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`config.json אינו JSON תקין: ${e.message}`);
  }
  if (!/^https?:\/\//.test(cfg.appUrl || '')) throw new Error('config.json: חסר appUrl (למשל https://ap-control.vercel.app)');
  if (!cfg.agentSecret || /אותו ערך/.test(cfg.agentSecret)) throw new Error('config.json: חסר agentSecret (אותו ערך כמו BANK_AGENT_SECRET ב-Vercel)');
  const logins = Object.entries(cfg.logins || {}).filter(([k, v]) => k && v?.userCode && v?.password && !/קוד משתמש/.test(v.userCode));
  if (!logins.length) throw new Error('config.json: אין אף משתמש ב-logins עם userCode ו-password');
  return cfg;
}

async function api(cfg, pathname, body) {
  const res = await fetch(new URL(pathname, cfg.appUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.agentSecret}`, // בכותרת בלבד — השרת לא מקבל סוד ב-URL
      'x-agent-name': NAME,
    },
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const why = res.status === 401 ? 'הסוד שגוי (agentSecret ≠ BANK_AGENT_SECRET)'
      : res.status === 503 ? 'הסוכן כבוי באפליקציה (לא הוגדר BANK_AGENT_SECRET ב-Vercel)'
      : (data?.error || res.statusText);
    throw new Error(`${res.status} ${why}`);
  }
  return data;
}

/** לעולם לא לשלוח לאפליקציה או להדפיס טקסט שמכיל את הסיסמה או קוד המשתמש. */
function scrub(msg, creds) {
  let s = String(msg || '');
  for (const v of [creds?.password, creds?.userCode]) if (v) s = s.split(String(v)).join('***');
  return s.slice(0, 400);
}

async function runJob(cfg, job) {
  const creds = cfg.logins?.[job.loginKey];
  if (!creds?.userCode || !creds?.password) {
    await api(cfg, `/ingest/bank-agent/${job.id}/state`, {
      status: 'failed',
      message: `אין במחשב המשרד פרטי בנק למשתמש "${job.loginKey}". יש להוסיף אותו ל-agent/config.json תחת logins.`,
    });
    log(`✗ #${job.id}: אין פרטי בנק עבור "${job.loginKey}" ב-config.json`);
    return;
  }

  // 🔴 הדיווחים נשלחים **בסדר** (שרשרת promise): בקשות HTTP מקבילות לא מגיעות בהכרח לפי הסדר,
  // ו"עובד…" שמגיע אחרי "ממתין לקוד" היה מעלים את שדה הקוד מהמסך. (השרת שומר על זה גם הוא.)
  let chain = Promise.resolve();
  let cancelled = false;
  const report = (status, message) => {
    chain = chain.then(async () => {
      const r = await api(cfg, `/ingest/bank-agent/${job.id}/state`, { status, message });
      if (r?.cancelled) cancelled = true;
    }).catch(() => { /* דיווח התקדמות שנכשל אינו סיבה לעצור */ });
    return chain;
  };

  try {
    const { default: puppeteer } = await import('puppeteer');
    const { scrapeHapoalimBiz } = await import('../src/scraper/hapoalimBiz.js');
    const days = Number(cfg.startDaysBack) > 0 ? Number(cfg.startDaysBack) : 60;

    const accounts = await scrapeHapoalimBiz({
      credentials: { userCode: creds.userCode, password: creds.password },
      startDate: new Date(Date.now() - days * 86_400_000),
      puppeteer,
      executablePath: cfg.chromePath || null,
      ...(cfg.bankBaseUrl ? { baseUrl: cfg.bankBaseUrl } : {}),
      showBrowser: Boolean(cfg.showBrowser),
      accountIds: Array.isArray(cfg.accountIds) && cfg.accountIds.length ? cfg.accountIds : null,
      failureScreenshotPath: cfg.debugScreenshots ? path.join(here, `fail-${job.id}.png`) : null,
      onProgress: (m) => { report('running', m); },
      onOtp: async () => {
        await report('awaiting_otp', 'הבנק שלח קוד SMS — הזן אותו כאן.');
        if (cancelled) throw new Error('CANCELLED');
        log(`… #${job.id}: ממתין לקוד SMS מהאפליקציה`);
        const until = Date.now() + OTP_WAIT_MS;
        while (Date.now() < until) {
          await sleep(OTP_POLL_MS);
          const r = await api(cfg, `/ingest/bank-agent/${job.id}/otp`);
          if (r.cancelled) { cancelled = true; throw new Error('CANCELLED'); }
          if (r.otp) return r.otp; // הקוד לא נכתב ללוג
        }
        throw new Error('לא הוזן קוד SMS בזמן. לחץ "סנכרן" שוב לקבלת קוד חדש.');
      },
    });

    await chain;
    if (cancelled) throw new Error('CANCELLED');
    const rows = accounts.reduce((n, a) => n + a.transactions.length, 0);
    log(`✓ #${job.id}: ${accounts.length} חשבונות, ${rows} תנועות — שולח לאפליקציה`);
    const r = await api(cfg, `/ingest/bank-agent/${job.id}/result`, { accounts });
    log(r?.cancelled ? `■ #${job.id}: בוטל לפני הקליטה` : `✓ #${job.id}: הושלם`);
  } catch (e) {
    if (cancelled || e.message === 'CANCELLED') { log(`■ #${job.id}: בוטל`); return; }
    // שגיאת הפעלת דפדפן היא בעיית התקנה במחשב הזה, לא בעיה בבנק — ומשפט אחד ברור עדיף על
    // עשרים שורות stderr של Chrome במסך של מי שלחץ "סנכרן".
    const raw = /Failed to launch the browser/i.test(e.message)
      ? 'הדפדפן במחשב המשרד לא עלה. הרץ "npm run check" בתיקיית הסוכן כדי לראות למה.'
      : e.message;
    const msg = scrub(raw, creds);
    log(`✗ #${job.id}: ${scrub(e.message, creds)}`);
    await chain;
    await api(cfg, `/ingest/bank-agent/${job.id}/state`, { status: 'failed', message: msg }).catch(() => {});
  }
}

async function check() {
  let ok = true;
  const step = async (label, fn) => {
    try { const note = await fn(); log(`✓ ${label}${note ? ` — ${note}` : ''}`); } catch (e) { ok = false; log(`✗ ${label} — ${e.message}`); }
  };
  let cfg = null;
  await step('קובץ ההגדרות', async () => { cfg = loadConfig(); return `${Object.keys(cfg.logins).length} משתמשים: ${Object.keys(cfg.logins).join(', ')}`; });
  if (cfg) {
    await step('חיבור לאפליקציה', async () => {
      const r = await api(cfg, '/ingest/bank-agent/ping');
      return r.ready ? 'מחובר' : 'מחובר, אבל צריך ללחוץ "עדכן מסד נתונים" בהגדרות';
    });
  }
  await step('הדפדפן עולה', async () => {
    const { default: puppeteer } = await import('puppeteer');
    const b = await puppeteer.launch({ headless: true, ...(cfg?.chromePath ? { executablePath: cfg.chromePath } : {}) });
    const v = await b.version();
    await b.close();
    return v;
  });
  log(ok ? 'הכול תקין. הרץ npm start והשאר את החלון פתוח.' : 'יש מה לתקן — ראה למעלה.');
  process.exit(ok ? 0 : 1);
}

async function main() {
  if (process.argv.includes('--check')) return check();
  let cfg = loadConfig();
  log(`סוכן סנכרון הבנק פועל על "${NAME}" מול ${cfg.appUrl}. משאירים את החלון פתוח.`);
  let backoff = 0;
  for (;;) {
    try {
      const { job } = await api(cfg, '/ingest/bank-agent/claim');
      backoff = 0;
      if (job) {
        log(`→ #${job.id}: בקשת סנכרון (${job.loginKey})`);
        cfg = loadConfig(); // משתמש שנוסף ל-config.json נכנס לתוקף בלי להפעיל מחדש
        await runJob(cfg, job);
        continue;
      }
    } catch (e) {
      backoff = Math.min((backoff || 5_000) * 2, 60_000);
      log(`! ${e.message} — מנסה שוב בעוד ${backoff / 1000} שניות`);
      await sleep(backoff);
      continue;
    }
    await sleep(IDLE_MS);
  }
}

process.on('SIGINT', () => { log('הסוכן נעצר.'); process.exit(0); });
main().catch((e) => { log(`✗ ${e.message}`); process.exit(1); });
