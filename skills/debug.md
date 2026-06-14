---
description: Systematic debugging assistant. Give it an error message, stack trace, or "it doesn't work" description and it will trace the root cause and fix it.
---

When this skill is invoked:

## Step 1 — Gather the error

If the user provided an error message or stack trace in the invocation, use it.
If not, ask: "מה השגיאה? (הדבק את ה-error message / stack trace)"

## Step 2 — Parse the error

From the error/stack trace, extract:
- **Error type** (TypeError, ReferenceError, 404, undefined is not a function, etc.)
- **File and line number** where it originated
- **The call chain** — which function called which

Read the file at the indicated line. Read surrounding context (±20 lines).

## Step 3 — Trace root cause

Work backwards through the call chain:
1. What value was expected at the failing line?
2. Where was that value set or passed from?
3. Follow it upstream until you find where the wrong value originated

Check common causes based on the error type:
- **undefined/null** → missing guard, wrong key name, async data not awaited, optional chaining needed
- **Type error** → wrong type passed, missing type conversion, API response shape mismatch
- **404/network** → wrong URL, wrong env var, missing route, CORS
- **Infinite loop/recursion** → missing base case, dependency array issue in useEffect
- **Build/compile error** → missing import, wrong export, circular dependency

## Step 4 — Propose the fix

State clearly:
1. **Root cause:** one sentence explanation
2. **Fix:** show the exact code change (before → after)
3. **Why this fixes it:** one sentence

Ask: "רוצה שאתקן?"

## Step 5 — Apply and verify

If yes, apply the fix using Edit.
After editing, re-read the file to verify the change looks correct.
If there are related places in the codebase that have the same bug pattern, scan for them using Grep and report them.
