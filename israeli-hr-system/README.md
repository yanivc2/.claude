# מערכת ניהול משאבי אנוש — לשוק הישראלי

אפליקציית ווב לניהול משאבי אנוש המותאמת לשוק הישראלי, בנויה ב-**Next.js (App Router)**, **Tailwind CSS**, **Prisma** ו-**PostgreSQL**. כל ממשק המשתמש בעברית עם תמיכה מלאה ב-RTL.

## שלושת המודולים

1. **עדכוני חקיקה** (`/legal-updates`) — משיכה אוטומטית שבועית (Cron) של עדכוני חקיקה ופסיקה מפידי RSS ומקורות ציבוריים, ותצוגה כרונולוגית בלוח הבקרה.
2. **התייעצות חוקים וזכויות** (`/consultation`) — צ'אטבוט מבוסס **RAG** (Retrieval-Augmented Generation) שמסתמך אך ורק על בסיס הידע המשפטי במסד הנתונים, כדי להבטיח תשובות מדויקות ומעודכנות. משתמש ב-Anthropic API (מודל `claude-opus-4-8`).
3. **מחזור חיי עובד** — קליטה, שימור ופיטורין:
   - **קליטה** (`/onboarding`) — טופס 101 דיגיטלי, העלאת ספח ת.ז, וחתימה דיגיטלית על הסכם העבודה.
   - **שימור** (`/retention`) — תזמון אוטומטי של סקרי שביעות רצון ל-30/60/90 ימים ופגישות חתך למנהל.
   - **פיטורין** (`/termination`) — מחולל מסמכים (הזמנה לשימוע, מכתב סיום העסקה) עם **חישוב אוטומטי של ימי ההודעה המוקדמת** לפי מועד תחילת העבודה.

## מבנה התיקיות

```
israeli-hr-system/
├── prisma/
│   ├── schema.prisma          # סכמת מסד הנתונים (כל המודלים)
│   └── seed.ts                # זריעת בסיס ידע ל-RAG + דוגמאות
├── src/
│   ├── app/
│   │   ├── layout.tsx         # פריסת שורש (RTL, עברית, סרגל צד)
│   │   ├── globals.css        # סגנונות גלובליים + Tailwind + RTL
│   │   ├── page.tsx           # לוח בקרה
│   │   ├── legal-updates/     # מודול עדכוני חקיקה
│   │   ├── consultation/      # צ'אטבוט RAG
│   │   ├── onboarding/        # קליטת עובד
│   │   ├── retention/         # שימור עובדים
│   │   ├── termination/       # סיום העסקה
│   │   └── api/
│   │       ├── onboarding/    # POST — יצירת עובד + טופס 101 + תזמון סקרים
│   │       ├── consultation/  # POST — שאלת RAG
│   │       ├── termination/   # POST — הפקת מסמכים + חישוב הודעה מוקדמת
│   │       └── cron/
│   │           ├── legal-updates/  # GET — משיכת חקיקה (שבועי)
│   │           └── retention/      # GET — שליחת סקרים (יומי)
│   ├── components/
│   │   ├── Sidebar.tsx
│   │   ├── OnboardingForm.tsx      # טופס 101 + העלאה + חתימה
│   │   ├── SignaturePad.tsx        # רכיב חתימה דיגיטלית
│   │   ├── TerminationForm.tsx
│   │   ├── ChatConsultation.tsx
│   │   └── LegalUpdatesFeed.tsx
│   └── lib/
│       ├── prisma.ts          # לקוח Prisma
│       ├── anthropic.ts       # לקוח Anthropic
│       ├── rag.ts             # אחזור + יצירת תשובה (RAG)
│       ├── legalFetcher.ts    # פענוח RSS ומשיכת עדכונים
│       ├── retention.ts       # תזמון וטיפול בסקרים
│       ├── termination.ts     # חישוב הודעה מוקדמת
│       └── documentGenerator.ts   # מחולל מסמכי סיום העסקה
├── vercel.json                # הגדרת Cron jobs
└── .env.example
```

## התקנה והרצה

```bash
# 1. התקנת תלויות
npm install

# 2. הגדרת משתני סביבה
cp .env.example .env
#    ערכו את DATABASE_URL ו-ANTHROPIC_API_KEY

# 3. יצירת סכמת מסד הנתונים
npm run db:generate
npm run db:push

# 4. זריעת בסיס הידע ל-RAG
npm run db:seed

# 5. הרצה
npm run dev
```

האפליקציה תעלה בכתובת http://localhost:3000.

## תזמון (Cron)

בפריסה ל-Vercel, קובץ `vercel.json` מתזמן אוטומטית:
- `/api/cron/legal-updates` — כל יום שני ב-06:00 (משיכת חקיקה שבועית).
- `/api/cron/retention` — כל יום ב-07:00 (שליחת סקרי שביעות רצון).

קריאות ה-Cron מאומתות מול `CRON_SECRET`.

## הערות ליישום בפרודקשן

- **RAG**: האחזור הנוכחי מבוסס מילות מפתח. לדיוק גבוה יותר מומלץ לעבור ל-embeddings וקטוריים (למשל `pgvector`).
- **קבצים וחתימות**: כרגע נשמרים כ-data URLs במסד. בפרודקשן יש להעלות ל-object storage (S3 וכד') ולשמור קישור בלבד.
- **RSS**: כתובות הפידים ב-`legalFetcher.ts` הן דוגמה — יש להחליף בכתובות בפועל, ולשקול שימוש בספרייה ייעודית (`rss-parser`).
- **מסמכים משפטיים**: הנוסחים ולוגיקת ההודעה המוקדמת הם כלי עזר — יש לאמת מול ייעוץ משפטי מוסמך לפני שימוש מחייב.

> המידע והמסמכים במערכת אינם מהווים תחליף לייעוץ משפטי פרטני.
