---
description: Generate a conventional commit message from the current staged diff, then commit. Analyzes what changed and why based on the code, not just filenames.
---

When this skill is invoked:

## Step 1 — Check git state

Run:
```bash
git status
git diff --staged
```

If nothing is staged, run `git diff` to see unstaged changes, then ask:
"אין קבצים staged. תרצה שאעשה `git add` לכל השינויים ואז אמשיך?"

If there are no changes at all, tell the user and stop.

## Step 2 — Analyze the diff

Read the staged diff carefully. Identify:
- **Type:** feat / fix / chore / refactor / test / docs / style / perf
- **Scope:** which module, component, or area changed (optional, keep short)
- **What changed:** the functional change in one line
- **Why:** infer from the code — what bug does this fix, what feature does this add?

## Step 3 — Draft the commit message

Format: `<type>(<scope>): <short imperative summary>` (max 72 chars)

Rules:
- Present tense, imperative mood: "add" not "added", "fix" not "fixes"
- No period at the end
- If the why is non-obvious, add a body paragraph (blank line after subject)
- If it closes an issue, add `Closes #N` at the end

Show the user the proposed message and ask: "נראה טוב? (y / תיקון)"

## Step 4 — Commit

If approved, run:
```bash
git commit -m "<message>"
```

If the user wants changes, revise and show again before committing.

Never run `git push` unless explicitly asked.
Never use `--no-verify`.
