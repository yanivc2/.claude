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
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BANK_AGENT_CONFIG || path.join(here, 'config.json');
const NAME = process.env.BANK_AGENT_NAME || os.hostname();
// כותרת HTTP מקבלת רק תווי ASCII — שם מחשב בעברית היה מפיל כל בקשה ("Cannot convert argument to a
// ByteString"). שם כזה נשלח בגוף הבקשה (`agent`), שהשרת קורא כשאין כותרת.
const NAME_IS_ASCII = /^[\x20-\x7e]*$/.test(NAME);
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
    // פנקס רשימות ב-Windows עלול לשמור "UTF-8 עם BOM" — JSON.parse נכשל עליו בהודעה סתומה
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`config.json אינו JSON תקין: ${e.message}`);
  }
  if (!/^https?:\/\//.test(cfg.appUrl || '')) throw new Error('config.json: חסר appUrl (למשל https://ap-control.vercel.app)');
  const sp = secretProblem(cfg.agentSecret);
  if (sp) throw new Error(`config.json: agentSecret ${sp}. הרץ: node bank-agent.mjs --add-login`);
  const entries = Object.entries(cfg.logins || {});
  if (!entries.some(([k, v]) => !loginProblem(k, v))) {
    const why = entries.map(([k, v]) => `"${k}": ${loginProblem(k, v)}`).join(' · ');
    throw new Error(`config.json: אין אף משתמש תקין ב-logins${why ? ` (${why})` : ''}`);
  }
  return cfg;
}

// הסוד נשלח בכותרת Authorization, ולכן חייב להיות ASCII. עברית בו = טקסט דוגמה שלא הוחלף.
function secretProblem(v) {
  const s = v == null ? '' : String(v).trim();
  if (!s) return 'חסר';
  if (/אותו ערך|הסוד/.test(s)) return 'עדיין טקסט הדוגמה';
  if (!/^[\x21-\x7e]+$/.test(s)) return 'מכיל תווים שאינם אותיות באנגלית/ספרות (כנראה טקסט דוגמה או שפת מקלדת)';
  if (s.length < 16) return 'קצר מדי';
  return null;
}

// למה שורה ב-logins לא שמישה — בלי לחשוף אף ערך. ערכי הדוגמה בעברית, וקוד משתמש בבנק אינו עברי,
// ולכן עברית בשדה = הדוגמה לא הוחלפה (ניסיון התחברות עם הדוגמה היה מבזבז ניסיון מול נעילת הבנק).
const HEBREW = /[\u0590-\u05FF]/;
const EXAMPLE_PASSWORDS = new Set(['סיסמת הבנק', 'הסיסמה שלה']);
// שם השדה נסלח לאותיות גדולות/קטנות ולקו מפריד (usercode / user_code / UserCode) — טעות הקלדה
// בשם השדה אינה סיבה להיכשל; הערך הוא מה שחשוב.
function credsOf(v) {
  const pick = (re) => { const f = Object.keys(v).find((k) => re.test(k)); return f === undefined ? undefined : v[f]; };
  return { userCode: pick(/^user[\s_-]?code$/i), password: pick(/^pass(word)?$/i) };
}
function loginProblem(key, v) {
  if (/^שם-המשתמש/.test(key)) return 'המפתח עדיין הדוגמה — צריך את שם המשתמש באפליקציה';
  if (!v || typeof v !== 'object') return 'הערך צריך להיות { "userCode": "...", "password": "..." }';
  const { userCode, password } = credsOf(v);
  const code = userCode == null ? '' : String(userCode).trim();
  const pass = password == null ? '' : String(password);
  if (userCode === undefined) {
    const extra = Object.keys(v).filter((f) => !/^password$/i.test(f)).length;
    return extra
      ? 'אין שדה בשם userCode — שם השדה נכתב בדיוק "userCode", ורק הערך שמימין לנקודתיים מוחלף'
      : 'חסר השדה "userCode"';
  }
  if (!code) return 'userCode ריק — קוד המשתמש בבנק נכתב בין המירכאות';
  if (HEBREW.test(code)) return 'userCode עדיין הדוגמה';
  if (password === undefined) return 'חסר השדה "password"';
  if (!pass) return 'password ריק';
  if (EXAMPLE_PASSWORDS.has(pass)) return 'password עדיין הדוגמה';
  return null;
}

async function api(cfg, pathname, body) {
  const res = await fetch(new URL(pathname, cfg.appUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.agentSecret}`, // בכותרת בלבד — השרת לא מקבל סוד ב-URL
      ...(NAME_IS_ASCII ? { 'x-agent-name': NAME } : {}),
    },
    body: JSON.stringify(NAME_IS_ASCII ? (body || {}) : { ...(body || {}), agent: NAME }),
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
  const entry = cfg.logins?.[job.loginKey];
  const creds = entry && !loginProblem(job.loginKey, entry)
    ? { userCode: String(credsOf(entry).userCode).trim(), password: String(credsOf(entry).password) }
    : null;
  if (!creds) {
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
      // החשבונות הרשומים באפליקציה (מהשרת, בכל בקשה) — רק הם נקראים מהבנק. null = שרת ישן.
      onlyAccounts: Array.isArray(job.accounts) ? job.accounts : null,
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

// `npm run add-login` — ממלא את config.json בשאלות, בלי לערוך JSON ביד. עריכה ידנית של קובץ שמערבב
// עברית ואנגלית ב-Notepad היא מלכודת: הכיוון מימין-לשמאל מערבב את סדר התווים, ושפת המקלדת
// מחליפה אותיות בלי שרואים. הסיסמה לא מוצגת בהקלדה ולא נכתבת לשום מקום מלבד הקובץ.
// קורא שורה אחת מהמקלדת. במצב raw אנחנו אלה שמדפיסים את מה שהוקלד — ולכן בשדה מוסתר פשוט לא
// מדפיסים. (readline של Node מדפיס הקשות בנתיב שלא ניתן להשתיק — הסיסמה הופיעה על המסך.)
let pendingInput = '';
function readLine(prompt, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    const tty = !!stdin.isTTY;
    stdout.write(prompt);
    let buf = '';
    let esc = 0;
    const finish = (rest) => {
      stdin.off('data', onData);
      if (tty) stdin.setRawMode(false);
      stdin.pause();
      pendingInput = rest;
      stdout.write('\n');
      resolve(buf.trim());
    };
    const feed = (chunk) => {
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk[i];
        if (esc) { if (esc === 1 && c === '[') esc = 2; else if (esc === 1 || /[@-~]/.test(c)) esc = 0; continue; }
        if (c === '\x1b') { esc = 1; continue; }
        if (c === '\r' || c === '\n') {
          let rest = chunk.slice(i + 1);
          if (c === '\r' && rest[0] === '\n') rest = rest.slice(1);
          finish(rest);
          return true;
        }
        if (c === '\x03') { if (tty) stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (c === '\b' || c === '\x7f') { if (buf) { buf = buf.slice(0, -1); if (tty && !hidden) stdout.write('\b \b'); } continue; }
        if (c < ' ') continue;
        buf += c;
        if (tty && !hidden) stdout.write(c);
      }
      return false;
    };
    function onData(chunk) { feed(chunk); }
    if (pendingInput) { const p = pendingInput; pendingInput = ''; if (feed(p)) return; }
    if (tty) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
  });
}

async function addLogin() {
  const ask = (q) => readLine(q);
  const askHidden = (q) => readLine(q, { hidden: true });
  const yes = async (q) => /^(כ|כן|y|yes)$/i.test(await ask(q));

  let cfg;
  try {
    cfg = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, '')) : {};
  } catch {
    console.log('config.json הנוכחי אינו JSON תקין — בונים אותו מחדש (הסוד ייבחר שוב).');
    cfg = {};
  }
  cfg.appUrl ||= 'https://ap-control.vercel.app';
  cfg.accountIds ??= [];
  cfg.startDaysBack ??= 60;
  cfg.showBrowser ??= false;
  cfg.logins = cfg.logins && typeof cfg.logins === 'object' ? cfg.logins : {};

  if (secretProblem(cfg.agentSecret)) {
    console.log(`הסוד בקובץ ${secretProblem(cfg.agentSecret)}.`);
    for (;;) {
      const v = (await askHidden('הדבק את BANK_AGENT_SECRET (קליק ימני; לא יוצג), או Enter ריק ליצירת סוד חדש: ')).trim();
      if (!v) {
        cfg.agentSecret = randomBytes(32).toString('hex');
        console.log(`\nנוצר סוד חדש. העתק אותו ל-Vercel ← Settings ← Environment Variables ← BANK_AGENT_SECRET,\nואז Deployments ← Redeploy:\n\n  ${cfg.agentSecret}\n`);
        break;
      }
      const p = secretProblem(v);
      if (!p) { cfg.agentSecret = v; console.log(`  נקלט (${v.length} תווים).`); break; }
      console.log(`  הסוד ${p} — נסה שוב.`);
    }
  }
  for (const [k, v] of Object.entries(cfg.logins)) {
    if (loginProblem(k, v)) { delete cfg.logins[k]; console.log(`הוסרה שורה לא שמישה: "${k}"`); }
  }

  do {
    console.log('\nהמפתח = מה שכתוב בכרטיס הסנכרון באפליקציה, "המפתח שלך במחשב המשרד".');
    const key = await ask('המפתח: ');
    if (!key) break;
    let userCode;
    for (;;) {
      userCode = await ask('קוד המשתמש בבנק (כמו במסך הכניסה של פועלים לעסקים): ');
      if (!userCode) continue;
      if (HEBREW.test(userCode)) { console.log('  הוקלד בעברית — החלף שפת מקלדת (Alt+Shift) ונסה שוב.'); continue; }
      break;
    }
    let password;
    for (;;) {
      password = await askHidden('סיסמת הבנק (לא תוצג בהקלדה): ');
      if (!password) continue;
      if (HEBREW.test(password) && !(await yes('  בסיסמה יש אותיות עבריות — אולי המקלדת בעברית? להשאיר כך? (כ/ל): '))) continue;
      const again = await askHidden('שוב, לאימות: ');
      if (again !== password) { console.log('  הסיסמאות לא זהות — שוב.'); continue; }
      break;
    }
    cfg.logins[key] = { userCode, password };
    writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    console.log(`✓ נשמר "${key}" (קוד משתמש: ${userCode.length} תווים, סיסמה: ${password.length} תווים).`);
  } while (await yes('\nלהוסיף עוד משתמש? (כ/ל): '));

  writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  console.log(`\nמשתמשים בקובץ: ${Object.keys(cfg.logins).join(', ') || '—'}. עכשיו: npm run check`);
  process.exit(0);
}

async function check() {
  let ok = true;
  const step = async (label, fn) => {
    try { const note = await fn(); log(`✓ ${label}${note ? ` — ${note}` : ''}`); } catch (e) { ok = false; log(`✗ ${label} — ${e.message}`); }
  };
  let cfg = null;
  await step('קובץ ההגדרות', async () => {
    cfg = loadConfig();
    const entries = Object.entries(cfg.logins);
    const good = entries.filter(([k, v]) => !loginProblem(k, v)).map(([k]) => k);
    for (const [k, v] of entries) { const p = loginProblem(k, v); if (p) log(`  ⚠ "${k}" יידלג: ${p}`); }
    return `${good.length} משתמשים מוכנים: ${good.join(', ')}`;
  });
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
  if (process.argv.includes('--add-login')) return addLogin();
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
