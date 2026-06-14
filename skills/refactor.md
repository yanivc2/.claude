---
description: Guided refactoring — analyzes code for complexity, duplication, and poor structure, proposes a refactor plan, and applies it with your approval. Never refactors without asking first.
---

When this skill is invoked:

## Step 1 — Get the target

If the user passed a file path or described what to refactor, use it.
If not, ask: "מה תרצה לעשות לו refactor? (קובץ, פונקציה, או תאר את הבעיה)"

Read the target file(s).

## Step 2 — Analyze

Scan for these refactor opportunities (report only what actually exists):

**Complexity**
- Functions over ~30 lines → candidates for extraction
- Nesting deeper than 3 levels → early-return / guard clause pattern
- Long condition chains → extract to named boolean or lookup table

**Duplication**
- 3+ identical or near-identical blocks → extract to shared function/hook
- Same logic in multiple components → custom hook or utility

**Naming**
- Single-letter variables (outside loops)
- Misleading names (name doesn't match what it does)
- Inconsistent naming style in same file

**Structure**
- One file doing too many unrelated things → split into focused modules
- Deep prop drilling (3+ levels) → Context or state manager
- Logic mixed into JSX → extract to handlers or hooks

**TypeScript**
- `any` types → proper types
- Non-null assertions `!` on unverified values → proper guards

## Step 3 — Present the plan

List each proposed change as a numbered item:
```
1. Extract lines 45–78 of UserCard.tsx into a separate `useUserPermissions` hook
   Reason: 34 lines of async logic buried in render function
   
2. Replace the 3 identical `formatDate` calls with a shared utility
   Reason: same 8-line block duplicated in Invoice.tsx, Receipt.tsx, Statement.tsx
```

Then ask: "רוצה שאבצע את כל אלו? או בחר מספרים ספציפיים"

## Step 4 — Apply

Apply only the approved changes, one at a time.
After each edit:
1. Re-read the file to verify correctness
2. Check that imports are updated if code was moved
3. Search for any other files that import the moved/renamed code and update them

## Step 5 — Verify nothing broke

After all changes:
- If there's a typecheck command (`npm run typecheck`) mention running it
- If tests exist for the refactored code, mention running them
- Do a final read of each changed file and confirm it looks correct
