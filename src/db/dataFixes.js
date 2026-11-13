import { getExecutor } from './adapter.js';

// תיקוני נתונים חד-פעמיים שרצים בלחיצה על "עדכן מסד נתונים" (`POST /settings/db-upgrade`), אחרי הסכימה.
// אין לי גישה למסד החי, ולכן תיקון של שורות קיימות עובר דרך הכפתור. כל תיקון אידמפוטנטי: אחרי שרץ פעם
// אחת אין לו עוד מה לשנות, ולחיצה חוזרת לא נוגעת בכלום. מחזיר שורה בעברית לכל תיקון ששינה משהו.

/**
 * 🏦 סניף 628 ולא 428 (בעלים 13/11: "תתקן את הסניף ל-628"). `seed.js` זרע את ארבעת חשבונות הפועלים
 * בסניף 428, ובבנק הסניף הוא 628. רק "הפועלים" בסניף 428 — סניף אחר שהוזן ביד לא נגוע. בשם התצוגה
 * ("… · הפועלים 428-…") מוחלף רק הרצף " 428-", כך שמספר חשבון שמכיל 428 לא משתנה. החלפה ב-JS ולא
 * ב-REPLACE של SQL — כדי שתעבוד זהה בשני הניבים.
 */
async function fixHapoalimBranch(x) {
  const rows = await x.many("SELECT id, display_name FROM bank_accounts WHERE bank_name = 'הפועלים' AND branch = '428'", []);
  for (const r of rows) {
    const name = String(r.display_name ?? '').split(' 428-').join(' 628-');
    await x.run("UPDATE bank_accounts SET branch = '628', display_name = ? WHERE id = ?", [name, r.id]);
  }
  return rows.length ? `סניף הבנק תוקן ל-628 ב-${rows.length} ${rows.length === 1 ? 'חשבון' : 'חשבונות'}.` : null;
}

export async function applyDataFixes(x = getExecutor()) {
  const notes = [];
  for (const fix of [fixHapoalimBranch]) {
    try {
      const note = await fix(x);
      if (note) notes.push(note);
    } catch (err) {
      notes.push(`תיקון נתונים נכשל: ${err.message}`);
    }
  }
  return notes;
}
