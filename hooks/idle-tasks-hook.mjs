#!/usr/bin/env node
// UserPromptSubmit hook (בעלים 21/10): "בתחילת כל שיחה לאחר יותר משעתיים שלא הייתה פעילה — תן רשימה של
// משימות שלא סיימנו". Claude לא יודע לבד כמה זמן עבר, ולכן ההוק מודד: חותמת זמן אחרונה (הודעה של הבעלים
// או סוף תור — `--touch` מ-Stop). כשעברו יותר מ-IDLE_HOURS שעות (או שאין חותמת — מכולה חדשה = שיחה חדשה),
// הוא מוסיף להקשר את המשימות הפתוחות מ-docs/משימות-פתוחות.md עם הוראה לפתוח בהן את התשובה.
//
// אותו קובץ רץ בשני מקומות: בפרויקט AP Control (scripts/) ובהגדרות האישיות (hooks/ בריפו .claude — כל
// פרויקט במחשב). כשאין את קובץ המשימות בפרויקט, הרשימה נקראת מהענף ap-control-split של הריפו שבו יושב
// הסקריפט (git fetch + git show). החותמת משותפת (תיקיית temp), ו"מנעול" לפי החותמת הקודמת מבטיח שכששני
// ההוקים רצים יחד — רק אחד מוסיף את הרשימה.
//
// קורא את רשימת המשימות וכותב חותמת זמן. אף פעם לא חוסם: כל שגיאה = יציאה שקטה (0) בלי פלט.
import { readFileSync, writeFileSync, existsSync, openSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const IDLE_HOURS = 2;
const TASKS_REL = 'docs/משימות-פתוחות.md';
const TASKS_BRANCH = 'ap-control-split';
// הסעיפים שנחשבים "לא סיימנו". "נסגר לאחרונה" לא נכלל.
const OPEN_SECTIONS = ['מחכה לפעולה של הבעלים', 'מחכה לבנק', 'הצעות שטרם הוחלטו'];

/** המשימות הפתוחות לפי סעיף: הכותרת המודגשת של כל פריט (בלי פריטים מסומנים ✅). */
export function openTasks(markdown) {
  const out = [];
  let section = null;
  for (const line of String(markdown || '').split('\n')) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) { section = OPEN_SECTIONS.find((s) => h[1].startsWith(s)) || null; if (section) out.push({ section, items: [] }); continue; }
    if (!section) continue;
    const item = /^(?:\d+[א-ת]?\.|-)\s+(.*)$/.exec(line);
    if (!item || /✅/.test(item[1].slice(0, 6))) continue;
    const bold = /\*\*(.+?)\*\*/.exec(item[1]);
    const title = (bold ? bold[1] : item[1]).replace(/`/g, '').trim().slice(0, 120);
    if (title) out[out.length - 1].items.push(title);
  }
  return out.filter((s) => s.items.length);
}

/** הטקסט שנכנס להקשר: הוראה + הרשימה. null כשאין מה להציג. */
export function idleContext(markdown, hours) {
  const groups = openTasks(markdown);
  if (!groups.length) return null;
  const since = hours == null ? 'בתחילת שיחה חדשה' : `אחרי ${Math.floor(hours)} שעות בלי פעילות`;
  const body = groups.map((g) => `${g.section}:\n${g.items.map((t) => `• ${t}`).join('\n')}`).join('\n\n');
  return `⏰ השיחה חוזרת ${since}. הבעלים ביקש (21/10): "בתחילת כל שיחה לאחר יותר משעתיים שלא הייתה פעילה — `
    + 'תן רשימה של משימות שלא סיימנו". פתח את התשובה ברשימה קצרה בעברית של המשימות הפתוחות האלה '
    + `(מ-${TASKS_REL} של AP Control), ורק אחר כך ענה להודעה עצמה.\n\n${body}`;
}

/** קובץ המשימות: מהפרויקט אם הוא שם, אחרת מהענף של AP Control בריפו שבו יושב הסקריפט. */
function tasksMarkdown(projectDir) {
  const local = join(projectDir, TASKS_REL);
  if (existsSync(local)) return readFileSync(local, 'utf8');
  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const git = (args, ms) => execFileSync('git', ['-C', repo, ...args], { timeout: ms, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { git(['fetch', '-q', '--depth=1', 'origin', TASKS_BRANCH], 10_000); } catch { /* בלי רשת — מה שכבר יש */ }
  for (const ref of ['FETCH_HEAD', `origin/${TASKS_BRANCH}`]) {
    try { return git(['show', `${ref}:${TASKS_REL}`], 5_000); } catch { /* הבא */ }
  }
  return null;
}

export const STATE_PATH = join(tmpdir(), 'claude-idle-tasks.json');

function main() {
  const now = Date.now();
  let last = null;
  try { last = Number(JSON.parse(readFileSync(STATE_PATH, 'utf8')).at) || null; } catch { last = null; }
  try { writeFileSync(STATE_PATH, JSON.stringify({ at: now })); } catch { /* בלי מצב — רק לא נזכור */ }
  if (process.argv.includes('--touch')) return; // מ-Stop: רק לרשום שהייתה פעילות
  const hours = last ? (now - last) / 3_600_000 : null;
  if (hours != null && hours <= IDLE_HOURS) return;
  // הוק בפרויקט + הוק אישי באותה הודעה רצים במקביל: רק מי שתופס את המנעול של החותמת הקודמת מדבר.
  try { closeSync(openSync(join(tmpdir(), `claude-idle-tasks.${last || 0}.lock`), 'wx')); } catch { return; }
  const md = tasksMarkdown(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const text = md && idleContext(md, hours);
  if (!text) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } }));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main(); } catch { /* אף פעם לא חוסם */ }
  process.exit(0);
}
