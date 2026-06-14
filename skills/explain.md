---
description: Explain a piece of code in plain language. Pass a file path, function name, or paste the code directly. Explains what it does, why it's structured this way, and any non-obvious decisions.
---

When this skill is invoked:

## Step 1 — Get the code

If the user passed a file path → read it.
If the user passed a function name → search for it with Grep, then read the file.
If the user pasted code inline → use that.
If nothing provided → ask: "איזה קוד תרצה שאסביר? (נתיב קובץ, שם פונקציה, או הדבק קוד)"

## Step 2 — Understand the context

Before explaining, quickly check:
- What module/component is this part of?
- What calls this code? (Grep for usages if helpful)
- Are there any related types or interfaces to read?

## Step 3 — Explain

Structure the explanation in layers — start high-level, then go deeper:

**מה זה עושה (תמונה גדולה)**
One paragraph: the purpose of this code in plain language. What problem does it solve?

**איך זה עובד (שלב אחרי שלב)**
Walk through the logic in sequence. For each meaningful step, explain:
- What happens
- Why it's done this way (not just what)

**החלטות לא מובנות מאליהן**
Explain any tricky parts: unusual patterns, edge cases being handled, why a specific approach was chosen over the obvious one.

**תלויות ו-side effects**
What does this code depend on? What does it change or affect outside itself?

## Rules for the explanation:
- Explain in Hebrew unless the user asked in English
- Calibrate depth to the code's complexity — a 5-line function doesn't need 3 paragraphs
- Use analogies for complex concepts when helpful
- Point to specific line numbers when referencing parts of the code
- Never just re-describe the code line-by-line — explain the *intent*, not the syntax
