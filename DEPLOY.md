# פריסה לענן (Vercel + Neon) — מדריך

מדריך זה מסביר איך להעלות את AP Control לענן: מסד נתונים **Neon (Postgres)**, אירוח **Vercel**,
ואחסון קבצים **Vercel Blob**. המערכת המקומית (SQLite) ממשיכה לעבוד ללא שינוי — הענן הוא נוסף.

## מה צריך פעם אחת

1. **חשבון Neon** (neon.tech) — צור פרויקט Postgres חדש והעתק את מחרוזת החיבור
   (`DATABASE_URL`, נראית כמו `postgres://user:pass@...neon.tech/db?sslmode=require`).
2. **חשבון Vercel** (vercel.com) — מחובר ל-GitHub.
3. **Vercel Blob** — בפרויקט Vercel: Storage → Create → Blob. העתק את
   `BLOB_READ_WRITE_TOKEN`.

## משתני סביבה (Vercel → Project → Settings → Environment Variables)

| משתנה | ערך | חובה |
|---|---|---|
| `DATABASE_URL` | מחרוזת החיבור מ-Neon | ✅ (מפעיל את מצב Postgres) |
| `BLOB_READ_WRITE_TOKEN` | הטוקן מ-Vercel Blob | ✅ (אחסון תמונות) |
| `SESSION_SECRET` | מחרוזת אקראית ארוכה (למשל `openssl rand -hex 32`) | ✅ (חתימת התחברות) |
| `OWNER_PASSWORD` | סיסמת הבעלים הראשונית | מומלץ |
| `SECRETARY_PASSWORD` | סיסמת המזכירה הראשונית | מומלץ |
| `TELEGRAM_BOT_TOKEN` | טוקן הבוט (אם רוצים התראות) | לא חובה |
| `PGSSL` | `require` (ברירת מחדל דורשת SSL; אל תשנה אלא אם צריך) | לא |

## הכנת מסד הנתונים (פעם אחת)

לפני הפריסה הראשונה, החל את הסכימה וזרע נתונים ל-Neon. מקומית, עם `DATABASE_URL` מוגדר:

```bash
DATABASE_URL="postgres://...neon.tech/db?sslmode=require" \
OWNER_PASSWORD=... SECRETARY_PASSWORD=... \
npm run db:setup
```

הפקודה יוצרת את כל הטבלאות (idempotent — בטוח להריץ שוב) וזורעת את החברות/חנויות/משתמשים.

## פריסה

1. חבר את המאגר ל-Vercel (Import Project). Vercel מזהה את `vercel.json` אוטומטית — כל הבקשות
   מנותבות ל-`api/index.js` (פונקציית serverless שעוטפת את אפליקציית Express).
2. ודא שמשתני הסביבה מוגדרים (למעלה).
3. Deploy. בסיום תקבל כתובת `https://<project>.vercel.app`.

## אחרי הפריסה

- היכנס עם `owner` / הסיסמה שהגדרת. **החלף סיסמאות** מיד (בשלב הבא נוסיף מסך שינוי סיסמה בממשק).
- **התקנה בנייד (PWA):** פתח את הכתובת בדפדפן הנייד → תפריט → "הוסף למסך הבית". האפליקציה
  תיפתח במסך מלא עם אייקון.

## הערות

- **גורף הבנק** (`npm run scrape`) לא רץ ב-Vercel serverless (הוא דורש דפדפן אוטומטי). הוא נשאר
  כלי מקומי — הרץ אותו מהמחשב מול אותו `DATABASE_URL` כדי לייבא תנועות לענן.
- **OCR** (tesseract) גם הוא מקומי בעיקרו; בענן הוא יוריד את התמונה מ-Blob לקובץ זמני אם יופעל.
- הקבצים (תמונות חשבוניות) נשמרים ב-Vercel Blob; כתובות ה-Blob אינן ניתנות לניחוש ומוגשות דרך
  המערכת המאומתת בלבד.
