---
name: claude-env-audit
description: Comprehensive audit of Claude Code global environment. Scans settings.json, CLAUDE.md, hooks, and memory for security issues, stale config, and missing best practices. Presents a severity-ranked report, then applies only the fixes the user approves.
risk: safe
---

# Claude Environment Audit

סקירה מקיפה של סביבת Claude Code הגלובלית ב-`~/.claude/`.

## When to Use
- בדיקה תקופתית של הסטאפ
- אחרי שינויים ב-settings / hooks
- כשמשהו בהתנהגות Claude Code נראה מוזר

---

## Phase 1 — SCAN (read-only, no changes)

קרא וסרוק בשקט. אל תבצע שום שינוי בשלב זה.

### 1.1 Security — settings.json allow list
קרא `~/.claude/settings.json` → `permissions.allow`.

חפש בכל entry:

**חשיפת tokens** — patterns:
- `sk-`, `r8_`, `sk_live_`, `sk_test_`, `ghp_`, `xoxb-`, `xoxp-`, `AIza`, `AKIA`
- מחרוזות באורך 20+ תווים עם אנטרופיה גבוהה (מספרים+אותיות+סימנים)

**הרשאות הרצת קוד שרירותית** (red flags):
- `Bash(python*)`, `Bash(python3*)`, `Bash(node *)`, `Bash(npx *)` עם wildcard
- `Bash(bash *)`, `Bash(sh *)`, `Bash(eval *)`, `PowerShell(Invoke-Expression *)`
- `Bash(curl * | *)` (pipe to shell)

### 1.2 Allow List Quality
עבור כל entry, סווג:
- **Stale** — פעולה חד-פעמית שלא תחזור (winget install, git clone /tmp/..., הורדת כלי ספציפי)
- **Redundant** — auto-allowed ממילא על ידי Claude Code: `cat`, `ls`, `git diff`, `git status`, `git log`, `git show`, `grep`, `find`, `head`, `tail`, `wc`, `pwd` וכל git read subcommand
- **Too broad** — wildcard שמכסה יותר ממה שנדרש
- **Valid** — נחוץ ולא מכוסה אחרת

### 1.3 Hooks Audit
קרא את `hooks` ב-settings.json. עבור כל hook בדוק:

**Stop hooks:**
- האם יש agents שמנסים להריץ פקודות shell? → agents ב-Stop לא יכולים להריץ shell ב-don't-ask mode
- האם command hooks מניחים שה-CWD הוא git repo? → חסר guard `if (Test-Path '.git')`
- האם יש הדפסת output לא רצויה כשאין git repo?

**PostToolUse hooks:**
- האם יש hook שבודק TypeScript (`tsc --noEmit`) אחרי Edit/Write על `.ts`/`.tsx`?

**SessionStart hooks:**
- האם יש בדיקת `node_modules` / `.env`?

**כל hook:**
- האם הcommand תקין? האם יש escaping בעיות ב-JSON?

### 1.4 CLAUDE.md Audit
קרא `~/CLAUDE.md`. בדוק:
- כלל `tsc --noEmit` לפני דיווח על סיום בפרויקטי TypeScript
- הגדרת `/install-review` — האם מוגבל ל-external sources או כולל built-in skills?
- חוקים עמומים שה-classifier עשוי לפרש בצורה רחבה מדי
- חוקים מיושנים שאינם רלוונטיים עוד

### 1.5 Memory System
בדוק `~/.claude/projects/` — מצא את תיקיית ה-memory של הפרויקט הנוכחי.
- האם MEMORY.md קיים?
- האם יש memory files? כמה? האם הם מכסים: user profile, feedback, project context?
- האם יש entries ב-MEMORY.md שמפנים לקבצים שלא קיימים?

### 1.6 Skills Health
הצצה מהירה ל-`~/.claude/skills/`:
- ספור skills מותקנים
- האם יש skills עם SKILL.md ריק או חסר?
- האם `secret-scanner` ו-`test-wizard` מותקנים?

---

## Phase 2 — REPORT

הצג דוח מובנה עם severity:

```
## 🔍 Claude Environment Audit

### 🚨 Critical
[בעיות ביטחוניות — tokens חשופים, arbitrary code execution]

### ⚠️ Important  
[hooks שבורים, allow list מנופח, CLAUDE.md חסר כללים]

### 💡 Suggestions
[שיפורים אופציונליים — memory חסרה, skills שיכולים לעזור]

### ✅ תקין
[מה עובד כהלכה]
```

לכל finding כלול:
- **מה נמצא** (ציטוט מדויק מהקובץ)
- **למה זה בעיה**
- **תיקון מוצע** (ספציפי — מה בדיוק לשנות)

לאחר הדוח שאל:
> **"אילו קטגוריות לתקן? Critical / Important / Suggestions / הכל / כלום"**

---

## Phase 3 — FIX (רק אחרי אישור מפורש)

תקן רק מה שהמשתמש אישר. לכל תיקון:
1. הצהר מה עומד להשתנות
2. בצע את השינוי (Edit / Write)
3. אמת (JSON valid, tsc נקי לפי הצורך)

**אסור:**
- למחוק allow entries ללא אישור ספציפי על כל entry
- לשנות hooks ללא הצגת before/after
- לבצע שינויים destructive ב-CLAUDE.md ללא אישור

**חובה:**
- לאחר כל שינוי ב-settings.json: `python -c "import json; json.load(open('...settings.json'))"`
- אחרי הכל: הצג סיכום של מה שהשתנה

---

## Standards Reference

### Allow list — auto-allowed (לא צריך entry):
`cat`, `ls`, `cd`, `head`, `tail`, `wc`, `grep`, `find`, `echo`, `pwd`, `which`,
`git status`, `git log`, `git diff`, `git show`, `git branch`, `git blame`,
`gh pr view`, `gh pr list`, `gh issue view`, `gh run list`

### Hooks — red flags:
- Agent ב-Stop hook שמריץ Bash/PowerShell → agents לא יכולים בdon't-ask mode
- Command hook שמריץ git ללא `if (Test-Path '.git')`
- PostToolUse חסר על TypeScript projects

### CLAUDE.md — must-have rules:
- תיאור סביבה (OS, shell, IDE)
- Non-negotiables (commit, push, external connections)
- Verify before done + tsc rule לTypeScript
- `/install-review` scope מוגדר
