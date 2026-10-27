#!/usr/bin/env node
// 🔁 מריץ את סוכן הבנק ומעלה אותו שוב אם נפל (בעלים 27/10: "תוסיף לעדכון הבא").
//
// למה: עם הפעמון (src/lib/agentBell.js) הסוכן כבר לא חייב לשאול את האפליקציה בעצמו — ולכן אין
// בדיקה קבועה שתגלה שהוא כבוי. סוכן שקרס היה נשאר כבוי עד ההפעלה מחדש הבאה של המחשב, ומגלים את זה
// רק כשלוחצים "סנכרן" ושום דבר לא קורה. כאן: קריסה → עולה שוב אחרי 10 שניות (ואם הוא נופל שוב
// ושוב — מרווח שמתארך עד 5 דקות, כדי שתקלה קבועה לא תהפוך ללולאה). יציאה מכוונת (Ctrl+C, קוד 0)
// עוצרת הכול. סגירת החלון עוצרת הכול — זו הדרך לכבות את הסוכן.
//
//   npm start             → הקובץ הזה (ממנו start-agent.bat / start-agent.command)
//   npm run agent-once    → הסוכן עצמו, בלי העלאה מחדש

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const AGENT = process.env.BANK_AGENT_SCRIPT || path.join(here, 'bank-agent.mjs');
const BASE_MS = Number(process.env.BANK_AGENT_RESTART_MS) || 10_000;
export const MAX_DELAY_MS = 5 * 60_000;
export const HEALTHY_RUN_MS = 10 * 60_000;

/** המרווח עד ההעלאה הבאה: ריצה ארוכה (10 דק׳+) = תקלה חדשה → מהתחלה; נפילה מהירה → כפול, עד 5 דק׳. */
export function nextDelayMs(prevMs, livedMs, baseMs = BASE_MS) {
  if (!prevMs || livedMs >= HEALTHY_RUN_MS) return baseMs;
  return Math.min(prevMs * 2, Math.max(MAX_DELAY_MS, baseMs));
}

const log = (msg) => console.log(`${new Date().toLocaleString('he-IL')} · ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let stopping = false;
  let child = null;
  // Ctrl+C בחלון מגיע גם לסוכן (שיוצא בקוד 0) וגם לכאן — אז לא מעלים אותו שוב. מעבירים אותו גם
  // הלאה, למקרה שהגיע רק לכאן (kill -INT), כדי שלא נחכה לנצח לסוכן שממשיך לרוץ.
  process.on('SIGINT', () => { stopping = true; child?.kill('SIGINT'); });
  process.on('SIGTERM', () => { stopping = true; child?.kill('SIGTERM'); });
  let delay = 0;
  for (;;) {
    const started = Date.now();
    child = spawn(process.execPath, [AGENT], { stdio: 'inherit' });
    const code = await new Promise((resolve) => {
      child.on('exit', (c, signal) => resolve(c ?? (signal ? `אות ${signal}` : null)));
      child.on('error', (e) => resolve(`שגיאה: ${e.message}`));
    });
    if (stopping || code === 0) process.exit(0);
    delay = nextDelayMs(delay, Date.now() - started);
    log(`⚠ הסוכן נפל (${code}) — מפעיל אותו שוב בעוד ${Math.round(delay / 1000)} שניות. לעצירה: Ctrl+C.`);
    await sleep(delay);
    if (stopping) process.exit(0);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
