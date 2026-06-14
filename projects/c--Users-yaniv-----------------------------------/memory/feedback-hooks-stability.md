---
name: feedback-hooks-stability
description: בעיות שהתגלו עם hooks שגרמו לתקשורת לא תקינה עם Claude
metadata:
  type: feedback
---

אסור להוסיף PostToolUse hook שמריץ npm/typecheck כשאין package.json בפרויקט.

**Why:** Hook כזה נכשל בכל Edit/Write ומזריק שגיאות לתוך tool results, שגורמות לבעיות תקשורת. בסשן של 2026-06-08 זה מנע תקשורת תקינה.

**How to apply:** לפני הוספת PostToolUse typecheck hook — בדוק שיש package.json. אם הפרויקט הוא לא npm project, אל תוסיף hook כזה כלל.

---

ב-`.claude.json` לא לאפשר מצב של מפתחות כפולים בסקשן `projects`.

**Why:** שינוי שם תיקיית פרויקט הותיר 2 רשומות עם case שונה (C: vs c:) שגרמו לParse error ב-PowerShell.

**How to apply:** כשפרויקט משנה שם תיקייה, נקה את הרשומה הישנה מ-.claude.json.
