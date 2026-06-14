---
name: claude-env-audit-auto
description: Fully automated Claude Code environment audit. Scans settings.json, hooks, and memory; researches the correct fix for each finding; applies high-confidence fixes without user interaction. Logs all actions to ~/.claude/audit-logs/. Designed for scheduled (unattended) execution.
risk: high
---

# Claude Environment Audit — Auto Mode

סריקה, מחקר, ותיקון אוטומטי של סביבת Claude Code. אין צורך באישור משתמש.

---

## Step 1 — Open the log

לפני כל פעולה, צור קובץ לוג:

```
~/.claude/audit-logs/<YYYYMMDD_HHmm>.md
```

כתוב header:
```markdown
# Claude Env Audit — <date>

## Scan Findings
...

## Actions Taken
...

## Deferred (manual review needed)
...
```

כל פעולה — כולל "לא נדרש שינוי" — תירשם בלוג לפני ביצועה.

---

## Step 2 — Scan

קרא:
1. `C:\Users\yaniv\.claude\settings.json` — במלואו
2. `C:\Users\yaniv\CLAUDE.md`
3. `C:\Users\yaniv\.claude\projects\c--Users-yaniv--claude\memory\MEMORY.md`

### 2.1 Security — tokens in allow list

עבור כל entry ב-`permissions.allow`, בדוק:

**Hardcoded token patterns:**
- `sk-`, `r8_`, `sk_live_`, `sk_test_`, `ghp_`, `xoxb-`, `xoxp-`, `AIza`, `AKIA`
- מחרוזות 20+ תווים עם אנטרופיה גבוהה (ספרות+אותיות+סימנים mixed)

אם נמצא: **HIGH CONFIDENCE — מחק אוטומטית** + כתוב ללוג את ה-entry שנמחק.

### 2.2 Allow list — redundant entries

Claude Code auto-allows הבאים (entry = מיותר):
```
cat, ls, cd, head, tail, wc, grep, find, echo, pwd, which,
git status, git log, git diff, git show, git branch, git blame, git stash list,
git remote, git ls-files, git rev-parse, git describe, git reflog, git shortlog,
git cat-file, git for-each-ref, git worktree list, git config --get,
gh pr view, gh pr list, gh pr diff, gh pr checks, gh pr status,
gh issue view, gh issue list, gh run view, gh run list,
gh workflow list, gh repo view, gh release view, gh release list, gh auth status,
docker ps, docker images, docker logs, docker inspect
```

אם entry מתאים בדיוק לאחד מאלו: **HIGH CONFIDENCE — מחק אוטומטית.**

### 2.3 Allow list — stale one-off entries

Stale = entry שמתאים לאחד מהpatterns:
- `winget install *`, `winget upgrade *`
- `git clone * /tmp/*` או `git clone * $env:TEMP*`
- `npm install -g *` (one-off global install)
- `Bash(pip install *)`, `Bash(pip3 install *)`
- כל entry שמכיל path לתיקייה זמנית (`/tmp/`, `$env:TEMP`, `C:\Temp\`)
- כל entry עם גרסה ספציפית שנראה חד-פעמי (e.g. `Bash(somelib@1.2.3)`)

אם entry מתאים: **HIGH CONFIDENCE — מחק אוטומטית.**

### 2.4 Allow list — arbitrary code execution risk

Red flags:
- `Bash(python *)`, `Bash(python3 *)` עם wildcard
- `Bash(node *)` עם wildcard (לא path ספציפי)
- `Bash(bash *)`, `Bash(sh *)`, `Bash(eval *)`
- `PowerShell(Invoke-Expression *)`, `PowerShell(iex *)`
- `Bash(curl * | *)` — pipe to shell

**Research step:** לפני פעולה — בדוק האם יש entry אחר בallow list שמכסה את אותה פונקציונליות בצורה מדויקת יותר. אם כן: **HIGH CONFIDENCE — מחק את הרחב, שמור את המדויק.**
אם לא ברור אם ניתן להחליף: **DEFERRED.**

### 2.5 Hooks audit

עבור כל hook ב-`Stop`:
- האם יש `"type": "agent"`? → agents לא יכולים להריץ shell ב-don't-ask mode.
  - **Research:** בדוק מה ה-agent אמור לעשות. אם ניתן להמיר לcommand hook — **HIGH CONFIDENCE — המר.**
  - אם הלוגיקה מורכבת מדי לcommand: **DEFERRED.**

עבור hooks שמריצים `git` ללא guard:
- חפש: command hook שמכיל `git ` אך לא `Test-Path '.git'`
- **HIGH CONFIDENCE** — עטוף: `if (Test-Path '.git') { <original> }; exit 0`

עבור PostToolUse TypeScript:
- האם יש hook על Edit/Write שבודק `.ts`/`.tsx` עם `tsc --noEmit`?
- אם לא: **HIGH CONFIDENCE — הוסף** (ראה template מטה).

### 2.6 Memory system

בדוק שכל entry ב-MEMORY.md מפנה לקובץ שקיים:
```
C:\Users\yaniv\.claude\projects\c--Users-yaniv--claude\memory\<file.md>
```
אם קובץ חסר: **HIGH CONFIDENCE — מחק את השורה מ-MEMORY.md** + כתוב ללוג.

---

## Step 3 — Research

לכל finding ברמת confidence לא-HIGH:

1. קרא את CLAUDE.md — האם יש כלל רלוונטי?
2. קרא memory files רלוונטיים
3. בהתבסס על כל המידע: קבע אם confidence עולה ל-HIGH או נשאר DEFERRED
4. כתוב את הנימוק ללוג

---

## Step 4 — Apply fixes

**סדר הפעולות:**
1. כתוב ללוג את הפעולה + נימוק + before state
2. בצע את השינוי (Edit על settings.json / MEMORY.md)
3. אמת: `python -c "import json; json.load(open(r'C:\Users\yaniv\.claude\settings.json'))"` — רק לאחר שינוי ב-settings.json
4. כתוב ללוג: SUCCESS או FAILED + error

**מגבלות אוטומטיות (אל תחצה אפילו אם confidence גבוהה):**
- לא יותר מ-8 מחיקות מallow list בריצה אחת
- לא לגעת ב-CLAUDE.md
- לא למחוק hooks שלמים — רק לתקן/לעטוף
- לא להוסיף allow entries חדשים (רק למחוק)

---

## Step 5 — PostToolUse TypeScript hook template

אם נדרש להוסיף (סעיף 2.5):

```json
{
  "matcher": "Edit",
  "hooks": [{
    "type": "command",
    "command": "$j = [System.Console]::In.ReadToEnd() | ConvertFrom-Json; $f = $j.tool_input.file_path; if ($f -notmatch '\\.(ts|tsx)$' -or -not (Test-Path 'tsconfig.json')) { exit 0 }; $r = npx tsc --noEmit 2>&1; if ($LASTEXITCODE -ne 0) { $lines = ($r | Select-Object -First 5) -join ' | '; $out = @{systemMessage = ('⚠️ TypeScript: ' + $lines)} | ConvertTo-Json -Compress; Write-Output $out }; exit 0",
    "shell": "powershell",
    "statusMessage": "בודק TypeScript..."
  }]
}
```

---

## Step 6 — Finalize log

סיים את קובץ הלוג:

```markdown
## Summary
- Fixed: <N> issues
- Deferred: <N> issues (see above)
- No action needed: <N> checks passed

Next run: next Saturday 08:00
```

סיים בשקט — אין צורך בפלט למשתמש.
