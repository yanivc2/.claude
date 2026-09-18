import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// 🔴 כל `var(--x)` בתצוגה חייב להיות מוגדר ב-nocturne.css.
//
// למה זו בדיקה ולא הערה: הדפים טוענים **רק** את nocturne.css (`partials/header.ejs`), אבל בקוד
// היו 22 שימושים ב-`var(--ok)`/`var(--bad)`/`var(--warn)` — שמות שמוגדרים ב-style.css, שאינו
// נטען בכלל. משתנה שאינו מוגדר אינו שגיאה: הדפדפן פשוט מתעלם מההכרזה, הטקסט יורש את צבעו,
// והמסך נראה תקין. כלומר "חוסר" ו"יתרה" הוצגו באותו צבע, ואף אחד לא יכול היה לראות שמשהו נשבר.
const ROOT = path.join(process.cwd(), 'src');
const css = readFileSync(path.join(ROOT, 'public/nocturne.css'), 'utf8');
const DEFINED = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(ejs|js)$/.test(e)) out.push(f);
  }
  return out;
}

test('כל משתנה CSS שמוזכר בתצוגות מוגדר ב-nocturne.css', () => {
  const missing = [];
  for (const f of [...walk(path.join(ROOT, 'views')), ...walk(path.join(ROOT, 'public'))]) {
    if (f.endsWith('nocturne.css')) continue;
    const src = readFileSync(f, 'utf8');
    // רק שימוש **בלי ערך גיבוי**: `var(--x, #c0392b)` הוא דפוס לגיטימי — הגיבוי חל ממילא.
    for (const m of src.matchAll(/var\((--[a-z0-9-]+)\s*\)/gi)) {
      if (!DEFINED.has(m[1])) missing.push(`${path.relative(ROOT, f)} → ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'משתנה שאינו מוגדר נבלע בשקט — ההכרזה פשוט לא חלה');
});

test('הצבעים שמבדילים חוסר מיתרה קיימים', () => {
  for (const v of ['--color-ok', '--color-bad', '--color-warn']) assert.ok(DEFINED.has(v), v);
});
