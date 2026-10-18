// בעלים 18/10 ("שיהיו אחד ליד השני ולא אחד מעל השני"): הכפתורים יצאו זה מעל זה אצל הבעלים ובדפדפן
// כאן — זה ליד זה. ה-HTML החדש הגיע עם קובץ עיצוב ישן: `/nocturne.css` נטען בלי גרסה, ודפדפן מחזיק
// גיליון סגנונות בזיכרון בין ניווטים באותה לשונית בלי לבדוק מול השרת. בנוסף, ה-ETag שהשרת מחזיר
// הוא גודל+זמן קובץ, וזמן הקובץ בחבילת Vercel קבוע (2018) — שינוי שלא משנה את הגודל לא נראה כשינוי.
// לכן כל CSS/JS מקומי שדף טוען נושא ?v=<BUILD_VERSION>: כל פריסה = כתובת חדשה = קובץ טרי.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const views = path.join(process.cwd(), 'src/views');
function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : (p.endsWith('.ejs') ? [p] : []);
  });
}

test('every local stylesheet and script a page loads carries ?v=<build>', () => {
  const bare = [];
  for (const f of walk(views)) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:src|href)="(\/[\w./-]+\.(?:css|js))(\?[^"]*)?"/g)) {
      if (!m[2] || !/buildVersion/.test(m[2])) bare.push(`${path.relative(views, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(bare, [], 'a bare URL keeps serving the previous deploy\'s file to an open tab');
});

test('the save row keeps "שמור סגירה" and "ייצוא" side by side', () => {
  const css = readFileSync(path.join(process.cwd(), 'src/public/nocturne.css'), 'utf8');
  assert.match(css, /\.zc-save-row \{ display: flex;[^}]*flex-wrap: nowrap; \}/);
});
