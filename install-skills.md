# התקנת סקילים — רשימת פקודות מאומתת

> נבנה אחרי `/install-review` (כלל #1 של הריפו). זו רשימת הפקודות להתקנה
> **על המכונה שלך** (`C:\Users\yaniv\.claude`). התקנה גלובלית משפיעה על **כל סשן**.
>
> **למה קובץ ולא התקנה ישירה:** הסביבה שבה נבנה הקובץ (Claude Code on the web)
> היא קונטיינר זמני, ותיקיית `skills/` היא gitignored — ולכן התקנת runtime שם
> לא נשמרת ולא מסונכרנת. חלק מהפריטים גם מותקנים רק דרך `/plugin` האינטראקטיבי.
> הרץ/י את הפקודות למטה מקומית.

## דרישות מקדימות

- Node + npm (יש `npx`).
- ה-`skills` CLI רץ דרך `npx` (אין צורך בהתקנה גלובלית): `npx skills --help`.
- מקרא: `-g` = התקנה גלובלית (user-level), `-y` = ללא אישורים אינטראקטיביים,
  `-l` = **רק להציג** את תוכן ה-repo בלי להתקין (מומלץ לבדיקה מקדימה).

## שני מנגנוני התקנה

1. **Skills** — `npx skills add <owner/repo> --skill <name> -g`
   מוריד את קובצי ה-`SKILL.md` ל-`~/.claude/skills/`. לא מריץ קוד בזמן ההתקנה.
2. **Plugins** — `/plugin marketplace add <owner/repo>` ואז
   `/plugin install <name>@<marketplace>`. פקודת slash **אינטראקטיבית** בתוך
   Claude Code (חבילה שיכולה לכלול גם hooks/פקודות/subagents).

> **הערת אבטחה כללית:** התקנת ה-SKILL.md עצמה לא מסוכנת — היא רק טקסט/הנחיות.
> הסיכון של הפריטים המסומנים ⚠️ מתממש **בזמן השימוש** (רשת החוצה, הרצת בינאריים,
> דפדפן). השתמש/י בהם במודעות.

---

## חלק 1 — Skills (דרך `npx skills add`)

מקובץ לפי repo. אפשר להתקין כמה סקילים מ-repo אחד בפקודה אחת.

### Anthropic (רשמי, מהימן מלא) — `anthropics/skills`
```bash
# Document Skills (10) + Skill Creator (14) + Webapp Testing (11)
# ⚠️ הפורמט הוא --skill חוזר (לא פסיקים ולא רווחים!)
npx skills add anthropics/skills --skill pdf --skill docx --skill xlsx --skill pptx --skill skill-creator --skill webapp-testing -g -y
```
- ✅ pdf / docx / xlsx / pptx / skill-creator — מריצים סקריפטי Python מקומית, מקור רשמי.
- ⚠️ webapp-testing — **מפעיל דפדפן Playwright ומריץ את האפליקציה המקומית**.

### Vercel Labs (רשמי, מהימן) — `vercel-labs/agent-skills`
```bash
npx skills add vercel-labs/agent-skills --skill web-design-guidelines --skill vercel-react-best-practices --skill vercel-composition-patterns -g -y
```
- ✅ כל השלושה — ניתוח/הנחיות בלבד. (סלאגים אומתו מול ה-repo.)

### Matt Pocock (מהימן) — `mattpocock/skills`
```bash
npx skills add mattpocock/skills --skill handoff --skill grill-me -g -y
```
- ✅ grill-me — prompt בלבד.
- ⚠️(קל) handoff — כותב קובצי markdown מקומית.

### Remotion (רשמי) — `remotion-dev/skills`
```bash
npx skills add remotion-dev/skills --skill remotion-best-practices -g -y
```
- ✅ ידע/הנחיות בלבד. (יש lookalike של צד-שלישי — העדף/י את `remotion-dev`.)

### Andrej Karpathy's Guidelines (צד-שלישי, תוכן פשוט) — `multica-ai/andrej-karpathy-skills`
```bash
npx skills add multica-ai/andrej-karpathy-skills -g -y
```
- ✅ ערכת חוקים (prompt בלבד). קומפילציה של צד-שלישי, לא נכתב ע"י Karpathy עצמו.

### Superpowers (מהימן, obra) — `obra/superpowers`
```bash
# מתקין את כל 14 הסקילים של החבילה כ-skills
npx skills add obra/superpowers -g -y --skill '*'
```
- ⚠️ חבילה גדולה: brainstorming, TDD, subagents, code-review, git-worktrees ועוד.
  משנה עמוקות זרימות עבודה. (אפשר גם כפלאגין — ראה/י חלק 2.)

### Trail of Bits Security (מהימן, חברת אבטחה) — `trailofbits/skills`
```bash
# פריט הגלריה "Trail of Bits Security" = CodeQL+Semgrep בלבד. התקנה ממוקדת:
npx skills add trailofbits/skills -g -y --skill codeql --skill semgrep --skill sarif-parsing
# ⚠️ שים/י לב:  --skill '*'  מושך 75 סקילים (כל ה-fuzzing/blockchain/crypto) — יותר מדי.
```
- ⚠️ **מריץ CodeQL + Semgrep** — מוריד ומריץ בינאריים לניתוח קוד בזמן שימוש.

### Caveman (צד-שלישי ויראלי) — `JuliusBrussee/caveman`
```bash
# ⚠️ אל תריץ/י את curl|bash שמופיע ב-README. השתמש/י ב-CLI הבטוח:
npx skills add JuliusBrussee/caveman -g -y
```
- ⚠️ משנה את **סגנון הפלט של כל סשן** (מקצץ נרטיב). שים/י לב: מתנגש עם כלל
  "הסברים תמיד בעברית" — ייתכן שתרצה/י לשמור אותו לפרויקטים ספציפיים ולא גלובלי.

---

## חלק 2 — Plugins (דרך `/plugin`, אינטראקטיבי בתוך Claude Code)

הרץ/י בתוך סשן Claude Code (לא ב-shell):

### Anthropic (רשמי) — `claude-plugins-official`
```
# חובה פעם אחת: לרשום את ה-marketplace הרשמי לפני כל התקנה ממנו:
/plugin marketplace add anthropics/claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install code-simplifier@claude-plugins-official
```
- ✅ frontend-design — הנחיות עיצוב UI.
- ✅ code-simplifier — agent לניקוי קוד (עורך קבצים; מקור רשמי).

### Firecrawl (ספק רשמי) — `firecrawl/firecrawl-claude-plugin`
```
/plugin marketplace add firecrawl/firecrawl-claude-plugin
/plugin install firecrawl@firecrawl
```
- ⚠️ **רשת החוצה** — שולח URLs ותוכן שנגרד ל-API של Firecrawl. דורש `FIRECRAWL_API_KEY`.

### Superpowers — חלופת פלאגין (אם מעדיף/ה על פני חלק 1)
```
/plugin install superpowers@claude-plugins-official
```

### Context Mode — ⚠️ מקור לא-חד-משמעי
```
# יש שני repos זהים בשם — אמת/י איזה מהם התכוונת לפני התקנה:
/plugin marketplace add mksglu/context-mode      # אפשרות א'
# או:  scottconverse/context-mode                # אפשרות ב'
/plugin install context-mode@context-mode
```
- ⚠️ **מיירט/מסנן פלט shell** — מוסיף hooks שמתערבים ב-context. צד-שלישי.
  **מומלץ לבדוק את קוד ה-hooks ידנית לפני התקנה.**

---

## סיכום ביקורת (מהיר)

| # | Skill | דירוג | הערה |
|---|---|---|---|
| 1 | Firecrawl | ⚠️ | רשת החוצה, API key |
| 2 | Handoff | ✅⚠️ | כותב קבצים |
| 3 | Grill Me | ✅ | prompt בלבד |
| 4 | Karpathy Guidelines | ✅ | צד-שלישי, תוכן פשוט |
| 5 | Frontend Design | ✅ | Anthropic רשמי |
| 6 | Superpowers | ⚠️ | חבילה גדולה, hooks/subagents |
| 7 | Vercel Web Design | ✅ | Vercel |
| 8 | Vercel React | ✅ | Vercel |
| 9 | Vercel Composition | ✅ | Vercel |
| 10 | Document Skills | ✅ | Anthropic רשמי |
| 11 | Webapp Testing | ⚠️ | דפדפן Playwright |
| 12 | Trail of Bits | ⚠️ | מריץ CodeQL/Semgrep |
| 13 | Remotion | ✅ | Remotion רשמי |
| 14 | Skill Creator | ✅ | Anthropic רשמי |
| 15 | Caveman | ⚠️ | פלט גלובלי, לא curl\|bash |
| 16 | Context Mode | ⚠️ | hooks, מקור דו-משמעי |
| 17 | code-simplifier | ✅ | Anthropic רשמי |

---

## חלק 3 — סבב שני: סקילים נוספים + MCP servers

### 3א. סקילים (דרך `npx skills add`)

```bash
# Impeccable — ערכת design-language (Paul Bakaus). מקור: pbakaus/impeccable
npx skills add pbakaus/impeccable -g -y --skill '*'

# front-end design — כבר מכוסה בחלק 1 (anthropics/skills --skill frontend-design)

# claude design — יש 2 פירושים שונים, בחר/י לפי הצורך:
#
# (א) Claude Design — פרויקטי design-system ב-claude.ai/design.
#     לא MCP ידני ולא plugin! זמין דרך סקיל /design-sync (+ /design-login),
#     מסתמך על ה-login של claude.ai. ה-backend: api.anthropic.com/v1/design/mcp.
#     שימוש:  /design-login  ואז  /design-sync
#
# (ב) התוסף "Design" (design critique / UX / a11y), ב-knowledge-work-plugins:
/plugin marketplace add anthropics/knowledge-work-plugins
/plugin install design@knowledge-work-plugins
```

- ✅ Impeccable — הנחיות עיצוב + detector דטרמיניסטי (58 חוקים, בלי LLM). בלי API key.
- ✅ claude design — התוסף הרשמי "Design" (design critique / UX writing / a11y / handoff),
  מ-`anthropics/knowledge-work-plugins`. שונה מ-`frontend-design`.

### 3ב. MCP servers (דרך `claude mcp add` — דורש הפעלה אינטראקטיבית + מפתחות)

> אלה **שרתים רצים**, לא סקילים. מתווספים ל-`.mcp.json` הגלובלי (blast-radius גבוה).
> רובם דורשים API key / מנוי. הרץ/י על המכונה, לא כאן.

```bash
# 21st.dev Magic — מחולל קומפוננטות UI. דורש API key מ-21st.dev
claude mcp add magic --scope user --env API_KEY="YOUR_21ST_KEY" -- npx -y @21st-dev/magic@latest

# Motion AI Kit — דוקס/דוגמאות אנימציה. דורש API key + מנוי Motion+ בתשלום
npx motion-ai          # מתקין אינטראקטיבי, בחר/י Claude Code

# Higgsfield — יצירת תמונה/וידאו. דורש חשבון + קרדיטים (בתשלום). ("map"≈"MCP")
claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp

# Playwright — אוטומציית דפדפן (Microsoft). ✅ בלי API key
# ✅ כבר נוסף ל-.mcp.json הגלובלי בריפו הזה (נכנס אוטומטית בכל סשן).
claude mcp add playwright -- npx -y @playwright/mcp@latest
```

| פריט | סוג | דגל |
|---|---|---|
| 21st.dev Magic | MCP | ⚠️ API key, רשת+הרצת שרת |
| Motion AI Kit | MCP | ⚠️ API key + מנוי בתשלום |
| Higgsfield | MCP | ⚠️ חשבון+קרדיטים בתשלום; רשת |
| Playwright | MCP | ✅ בלי key; מריץ דפדפן על אתרים חיים |
