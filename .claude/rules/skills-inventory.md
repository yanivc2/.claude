---
paths:
  - "settings.json"
  - ".claude/settings.json"
  - "commands/skills-audit.md"
---

# Skills inventory & triage

> **Applies to:** which skills are installed, where each kind actually lives, which
> stay enabled, and how the set stays identical on both machines. Loaded on demand.
> Explanations in Hebrew (rule #3); skill identifiers stay in English.
> Last triaged: 2026-10-21.

## שלושה סוגי skills — ושלושה מקומות שונים

| סוג | איפה בפועל | בריפו? |
|---|---|---|
| מסונכרנים מ־claude.ai (52) | `~/.claude/skills/synced/<bucket-guid>/` | לא |
| מותקנים דרך `npx skills` | junction ב־`~/.claude/skills/<name>` → `~/.agents/skills/<name>` | לא |
| routers (2) | `skills/design-router/`, `skills/dev-workflow-router/` | **כן** |

**ה־52 המסונכרנים יושבים רמה אחת עמוק יותר ממה שנדמה.** הם **אינם** ב־`~/.claude/skills/`
עצמה, אלא תחת `synced/<bucket-guid>/`. כל סקריפט או הוק שסורק רק את הרמה העליונה
יפספס את כולם — ר' `hooks/skills-drift.mjs`, שסורק במכוון את שתי הרמות.

בתוך ה־52: שלושה־עשר `israeli-*`, שני `hebrew-*`, וכן `sm-campaign-plan`,
`sm-social-content`, `supplier-price-comparison`, `excel-catalog`, `vault-keeper`,
`organize-folders` ו־`skill-creator`.

- **מחיקה מקומית של synced חוזרת בסנכרון הבא.** הבקרה האמיתית: `/skills` (השבתה)
  או claude.ai (הסרה/כיבוי מוחלט).
- **synced לא ניתן לעריכה במקום.** להתאמה אמיתית — לשכפל ל־skill מקומי דרך `skill-creator`.
- כל skill דלוק מוסיף לפרומפט המערכת בכל תור; לכן צמצום = חיסכון context.

## ארבעה אירועי התקנה (לפי חותמות הזמן של התיקיות)

| מתי | מה | איך |
|---|---|---|
| 2026-06-07 | 1,469 סקילים | התקנה המונית אחת, בפעולה אחת |
| 2026-07-23 | 36 סקילים | התקנות מכוונות, אחת־אחת |
| 2026-09-21–24 | 52 סקילים | הסנכרון מ־claude.ai |
| 2026-10-21 | 15 סקילים | `emilkowalski/skills` |

חותמות הזמן הן מה שאיפשר להפריד בין ההתקנה ההמונית לבין ההתקנות המכוונות —
בלעדיהן אין דרך לדעת מה נבחר ומה נגרף פנימה.

## הניקוי של 2026-10-21

1,472 תיקיות **הועברו** אל `C:\Users\yaniv\.agents\skills-archive\2026-06-07-bulk`.
הועברו, לא נמחקו (כלל "אין מחיקות קשות"). נשארו 61 — כל אחת מהן התקנה מכוונת.

> ספירת בקרה שבוצעה היום החזירה 63 תיקיות ב־`skills/`, כולל `synced/` ושני
> ה־routers, כלומר 60 התקנות. הפער מול 61 קטן ולא הוכרע — אל תסתמך על המספר
> המדויק, ספור מול הדיסק.

## למה זה היה קריטי: תקציב התיאורים

| | לפני | אחרי |
|---|---|---|
| תווי תיאור שנטענים | 245,029 | 6,420 |

התקציב שמוקצה לאינדקס הסקילים הוא בערך **1% מחלון ההקשר**. עם 245,029 תווים
כל תיאור נחתך לכדי כלום — ולכן **אף skill לא היה יכול להיטען אוטומטית**. זו לא
הייתה בעיה של רעש; המערכת פשוט לא עבדה. `skillListingMaxDescChars` עומד עכשיו
על `200`.

## שלוש דרגות ב־`skillOverrides`

| דרגה | כמה | מה זה אומר |
|---|---|---|
| דלוק (ללא רשומה) | 34 | נטען אוטומטית, מוסיף לתקציב |
| `user-invocable-only` | 47 | נטען רק בהפעלה מפורשת — לא עולה כלום עד שקוראים לו |
| `off` | 28 | לא קיים לסשן |

הדרגה האמצעית היא העיקר: היא מחזיקה את חבילות העיצוב וזרימת־העבודה זמינות
בלי לשלם עליהן תקציב. מי שצריך את הידע שלהן בלי לקרוא להן — מקבל אותו מה־routers.

## שני ה־routers

`skills/design-router/` ו־`skills/dev-workflow-router/` נוצרו ב־2026-10-21.
כל אחד מהם מחזיק אינדקס של הסקילים בתחומו (צורך → הפקודה להרצה) **ובנוסף את
עקרונות הליבה inline**. התוצאה: הידע זמין בלי לטעון עשרים תיאורים, ובלי להסתמך
על זיכרון. אלה היחידים מתוך `skills/` שנמצאים בגיט — הם קונפיג בכתב יד, לא התקנה.

## `.gitignore` — למה `skills/*` ולא `skills/`

```gitignore
skills/*
!skills/*-router/
```

הסימן הוא ה־`/*`: git **אינו** יכול להחזיר נתיב שנמצא מתחת לתיקייה שהוחרגה
במלואה. עם `skills/` השורה השנייה לא הייתה עובדת, וה־routers לא היו נשמרים.

## המניפסט והוק הדריפט

- **`skills-manifest.json`** בשורש הריפו — עשרה מקורות, ולכל מקור רשימת הסקילים
  שלו **ופקודת ההתקנה המדויקת**. רק סקילים שמותקנים דרך `npx` רשומים: המסונכרנים
  מגיעים לבד, וה־routers נוסעים בגיט. יש גם בלוק `ignore` לסקילים שקיימים
  במכונה אחת בכוונה ולא נרצים באחרת.
- **`hooks/skills-drift.mjs`** — הוק `SessionStart` שמשווה את המניפסט למה שמותקן
  בפועל ומדווח על הפער בעברית. **הוא לא מתקין ולא מוחק דבר**, לא ניגש לרשת,
  וכל שגיאה פנימית שלו יוצאת שקט ב־0 — הוק שבור לא חוסם סשן.
- **`/skills-sync`** — להתקין את מה שחסר. **`/skills-record`** — לרשום במניפסט מה
  שהותקן כאן ידנית, כדי שיגיע גם למכונה השנייה.

## מלכודת: קוד היציאה של ה־`skills` CLI משקר

הפקודה מסיימת במה שנראה ככישלון מוחלט:

```
x  Failed to install N
   ✗ <name> → PromptScript: PromptScript does not support global skill installation
```

**ההתקנה בכל זאת הצליחה.** ה־CLI מתקין לכמה יעדים במקביל; רק היעד PromptScript
נכשל, ו־Claude Code הצליח. **אל תסמוך על קוד היציאה — תמיד אמת מול מערכת הקבצים**
(`~/.agents/skills/` והג'נקשנים ב־`~/.claude/skills/`).

## `~/.agents/skills` — קיים, לא מטופל

מחזיק בערך 1,030 עותקים שמשרתים את Codex, Gemini CLI ו־Antigravity. **Claude Code
לא קורא משם**, ולכן זה לא עולה context — אבל התיקייה לא נוגעה בניקוי של היום
ושווה החלטה נפרדת. הג'נקשנים של הסקילים שמותקנים דרך `npx` מצביעים לשם.

## פרופיל השימוש (עוגן להחלטות)

עסק ישראלי + פיתוח: `israeli-hr-system` (Next.js, שכר/טופס 101/סקרי 30-60-90),
אפליקציית ספקים/מינימרקט "Store Management", כספת Obsidian, פיננסים לעסק ישראלי,
שיווק דרך Metricool. עברית + RTL.

## ✅ להשאיר דלוקים

- **פיננסים/רגולציה ישראלי:** `israeli-payroll-calculator`, `israeli-bookkeeping-automation`,
  `israeli-e-invoice`, `israeli-receipt-scanner`, `israeli-client-payment-chaser`,
  `israeli-corporate-tax-strategy`, `israeli-ecommerce-compliance`, `israeli-privacy-shield`,
  `israeli-appsec-scanner`
- **המוצרים:** `sm-campaign-plan`, `sm-social-content`, `supplier-price-comparison`, `excel-catalog`
- **שיווק ישראלי:** `israeli-paid-ads`, `israeli-email-sequences`, `hebrew-seo-geo-toolkit`,
  `hebrew-survey-builder`
- **מסמכים/דאטה/מכונה:** `docx`, `pdf`, `xlsx`, `vault-keeper`, `organize-folders`
- **קונפיג/פיתוח:** `skill-creator`, `address-github-comments`, `accesslint-audit`

## ⛔ מכובים (`off`)

- **רעש — לא בתחום:** `00-andruia-consultant`, `10-andruia-skill-smith`,
  `20-andruia-niche-intelligence`, `advogado-especialista`, `active-directory-attacks`,
  `aegisops-ai`, `agent-evaluation`, `agentflow`, `acceptance-orchestrator`,
  `3d-web-experience`, `activecampaign-automation`, `import-memory`, `007`,
  `ab-test-setup`, `2slides-ppt-generator` (API חיצוני עם מפתח; `pptx` מכסה)
- **כפילויות:** נגישות — להשאיר `accesslint-audit` בלבד, ולכן `accesslint-scan`,
  `accesslint-diff`, `accessibility-compliance-accessibility-audit` מכובים.
  תוכן/קריאייטיב — הספציפי גובר על הגנרי, ולכן `israeli-social-content`, `ad-creative` מכובים.
- **פלט גלובלי:** חבילת `caveman` (`caveman`, `cavecrew`, `caveman-commit`,
  `caveman-compress`, `caveman-help`, `caveman-review`, `caveman-stats`) ו־`superpowers-lab`.
  הסיבה: הן משנות את סגנון הפלט של כל סשן ומתנגשות עם כלל #3 (עברית).

## ⚠️ קבוצת "החלטת שימוש" — הוכרעה

הקבוצה שהמתינה לנתוני שימוש נפתרה בדרגה האמצעית ולא בכיבוי: `canvas-design`,
`docs`, `morning`, `mcp-builder`, `web-artifacts-builder` הם עכשיו
`user-invocable-only` — זמינים בקריאה מפורשת, בלי עלות תקציב. `pptx` נשאר דלוק.
`2slides-ppt-generator` עבר ל־`off`.

## שתי צורות מפתח לכל skill מסונכרן

ב־`settings.json` כל skill מסונכרן שמכובה או מוגבל מופיע **בשתי הצורות** —
`<name>` וגם `anthropic-skills:<name>` — כי לא אומת איזו צורה תופסת בפועל,
ומפתח לא־מוכר מתעלמים ממנו בלי נזק. הסקילים שמותקנים דרך `npx` מופיעים בצורה
אחת (בלי קידומת).

- **שינויי `settings.json` חלים רק אחרי `git pull`** של main ל־`~/.claude` במכונה.
- **אימות:** `/skill-doctor`.
- להסרה מוחלטת (לא רק השבתה): לכבות/למחוק ב־claude.ai; אחרת נשאר זמין לסנכרון.

## פתוח / לא ידוע

- ב־`skills/` יש גם קובצי `.md` בודדים ישר בשורש התיקייה, לצד
  `.antigravity-install-manifest.json`. הם לא היו חלק מהמיון הזה, ולא נבדק אם
  Claude Code טוען אותם בכלל (הוא טוען תיקייה עם `SKILL.md`). **לא ידוע** — דורש
  סבב נפרד.
- `~/.agents/skills` (בערך 1,030 עותקים) לא נוגע.

## תחזוקה

- עדכון תאריך "Last triaged" בראש הקובץ בכל מיון מחדש.
- כל התקנה חדשה: `/skills-record`, אחרת הוק הדריפט יצעק עליה בסשן הבא.
