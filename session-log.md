## 2026-09-20 23:35
- הוספת שרת MCP של 21st.dev ל-`.mcp.json` (`type: http`, `https://21st.dev/api/mcp`), המפתח מוזרק דרך `${input:st21_api_key}` (`promptString`, `password`) ולא נכתב בקובץ; לצד `github` ו-`playwright`
- הרצת `/install-review` לפני ההוספה (verdict: התקן בזהירות — מפתח מחוץ ל-git, נקודת קצה חיצונית אחת); לא ב-`plugins/blocklist.json`
- מיון ה-skills המסונכרנים מ-claude.ai לפי `/skill-doctor`: זוהה ש-`skills/` מוחרג ב-`.gitignore` ולכן לא ניתן לעריכה/מחיקה מהריפו, ומחיקה מקומית חוזרת בסנכרון (הבקרה: `/skills` או claude.ai). מומלץ לכבות 18 skills (13 רעש + 5 כפילויות)
- יצירת קובץ עוגן `.claude/rules/skills-inventory.md` עם המיפוי (להשאיר/לכבות + אילוץ הסנכרון), עם הפניה מ-`config-repo.md`
- הסביבה סופקה מחדש מ-main עדכני (`a468103`, PR #107/#108) באמצע העבודה; הענף `claude/plugins-rjq0x1` נבנה מחדש על main העדכני עם שני השינויים ופתרון קונפליקט `.mcp.json` מול שרת `playwright` שנוסף ב-main — בלי לאבד שינויים
- נפתח PR #109, אומת שאין CI בריפו (0 workflows/checks) ומצב מיזוג `clean`, ומוזג ל-main (squash) בקומיט `02a418f`; המנוי וה-check-in נוקו
- נותר בידי המשתמש: ייצור מפתח 21st.dev ב-`21st.dev/mcp` והזנה דרך `/mcp`, וכיבוי 18 ה-skills דרך `/skills`

## 2026-07-11 14:10
- בניית מערכת ניהול משאבי אנוש לשוק הישראלי בתיקייה `israeli-hr-system/` (Next.js App Router, Tailwind, Prisma, PostgreSQL, עברית + RTL מלא)
- שלושה מודולים: עדכוני חקיקה (cron שבועי + משיכת RSS ומניעת כפילויות), צ'אטבוט התייעצות מבוסס RAG (Anthropic `claude-opus-4-8`, מסתמך רק על בסיס הידע במסד), ומחזור חיי עובד — קליטה (טופס 101 + העלאת ספח ת.ז + חתימה דיגיטלית), שימור (סקרי 30/60/90 יום), פיטורין (מחולל הזמנה לשימוע ומכתב פיטורין עם חישוב הודעה מוקדמת אוטומטי)
- כולל סכמת Prisma, פריסת RTL, API routes, שני cron endpoints, seed לבסיס הידע, README
- אימות: `prisma validate` תקין, `next build` עבר type-check נקי; שדרוג `@anthropic-ai/sdk`→^0.111.0 (adaptive thinking) ו-`next`→^15.5.4 (CVE)
- הוספת GitHub Actions workflow (`.github/workflows/ci.yml`) שמריץ prisma validate + next build על PRs — רץ ירוק
- נפתח PR #1, נעקב ה-CI, מוזג ל-main (squash) בקומיט `e415c22`, וענף `claude/israeli-hr-system-4m32j4` נמחק

## 2026-06-17 05:19
- 78723cf commit

## 2026-06-17 05:17
- 78723cf commit

## 2026-06-17 05:10
- שיחה ללא שינויי קוד

## 2026-06-17 04:36
- שיחה ללא שינויי קוד

## 2026-06-17 04:25
- שיחה ללא שינויי קוד

## 2026-06-17 04:08
- שיחה ללא שינויי קוד

## 2026-06-17 04:06
- שיחה ללא שינויי קוד

## 2026-06-17 04:06
- שיחה ללא שינויי קוד

## 2026-06-17 04:04
- שיחה ללא שינויי קוד

## 2026-06-17 04:03
- שיחה ללא שינויי קוד

## 2026-06-17 04:00
- שיחה ללא שינויי קוד

## 2026-06-17 03:58
- שיחה ללא שינויי קוד

## 2026-06-17 03:54
- שיחה ללא שינויי קוד

## 2026-06-17 03:48
- שיחה ללא שינויי קוד

## 2026-06-17 03:45
- שיחה ללא שינויי קוד

## 2026-06-17 03:40
- שיחה ללא שינויי קוד

## 2026-06-17 03:34
- שיחה ללא שינויי קוד

## 2026-06-17 03:32
- שיחה ללא שינויי קוד

## 2026-06-17 03:32
- שיחה ללא שינויי קוד

## 2026-06-17 03:30
- שיחה ללא שינויי קוד

## 2026-06-17 03:26
- שיחה ללא שינויי קוד

## 2026-06-17 03:16
- שיחה ללא שינויי קוד

## 2026-06-17 03:15
- שיחה ללא שינויי קוד

## 2026-06-17 03:06
- שיחה ללא שינויי קוד

## 2026-06-17 03:04
- שיחה ללא שינויי קוד

## 2026-06-16 03:44
- 341ff78 chore: untrack ephemeral dirs and skills, fix broken typecheck hook | a4b8dc8 chore: add .gitignore and stop tracking ephemeral files | 87d9bfc fix: replace Stop agent hook with command hook for session logging

## 2026-06-16 03:37
- a4b8dc8 chore: add .gitignore and stop tracking ephemeral files | 87d9bfc fix: replace Stop agent hook with command hook for session logging | 1622030 fix: broaden Write permission to glob for Stop hook agent
