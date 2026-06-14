---
name: feedback-install-review
description: "חובה להפעיל /install-review לפני כל התקנה של skill, hook, או חבילה חיצונית — ללא יוצא מן הכלל"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 4ba9a529-1c39-484c-9629-20be32efb478
---

עצור לפני כל `npm install`, `npx skills add`, או העתקת קבצים ל-`~/.claude/skills/` — חייב להפעיל `/install-review` תחילה.

**Why:** המשתמש קבע חוק מפורש ב-CLAUDE.md. בשיחה אחת הותרתי `npm install -g @googleworkspace/cli` לרוץ בלי סקירה — למרות שציינתי את הכלל בעצמי. המשתמש הדגיש: "אם יש חוק אי אפשר לא לבצע."

**How to apply:** אם `/install-review` לא זמין כ-skill — מסרב להתקין ומודיע למשתמש. אין יוצאים מן הכלל, גם לא לחבילות "מוכרות" או "בטוחות לכאורה".
