---
description: Review a GitHub pull request — fetches the PR diff, checks for correctness bugs, code quality, security issues, and leaves structured feedback. Pass a PR number or URL as argument.
---

When this skill is invoked:

## Step 1 — Get the PR

If a PR number or URL was passed as an argument, use it.
If not, ask: "Which PR number (or URL) should I review?"

Run to fetch the PR details:
```bash
gh pr view <NUMBER> --json number,title,body,headRefName,baseRefName,author,files,additions,deletions
```

Then get the full diff:
```bash
gh pr diff <NUMBER>
```

If `gh` is not authenticated, tell the user to run `gh auth login` and stop.

## Step 2 — Understand context

Read the PR title, description, and linked issues. If the description is empty, note that it's missing (good PRs explain what changed and why).

Check the scope: how many files changed? If it's a very large PR (>20 files or >500 lines), warn the user that a large PR is hard to review reliably, but continue.

## Step 3 — Review the diff

Go through the diff carefully. Organize findings under these categories. **Only include categories that have actual findings** — omit empty ones.

### Correctness bugs
Issues that will cause incorrect behavior at runtime:
- Off-by-one errors, wrong conditions, null dereferences
- Race conditions, missing awaits, unhandled promise rejections
- Wrong API contract (wrong HTTP method, missing required field, wrong status code handling)
- State mutations that should be immutable updates

### Security issues
- SQL/command injection, XSS via dangerouslySetInnerHTML or string concatenation in HTML
- Secrets or credentials hardcoded
- Missing input validation at system boundaries (API routes, form handlers)
- Overly permissive CORS, auth bypass

### Code quality
- `any` type in TypeScript (should be `unknown` or a specific type)
- `console.log` left in
- Commented-out code blocks
- Functions over ~30 lines that should be extracted
- Magic numbers that should be named constants
- No error handling on operations that can fail (fetch, file ops, DB queries)

### Missing tests
- New logic paths with no test coverage
- Bug fix with no regression test

### Nits (non-blocking)
- Naming improvements
- Minor style inconsistencies

## Step 4 — Format the review

Output in this structure:

---
## PR Review: #<NUMBER> — <title>

**Author:** <author> | **Branch:** `<head>` → `<base>`  
**Changes:** +<additions> / -<deletions> across <N> files

### Summary
<2–3 sentences: what the PR does and overall assessment — "looks good", "has one blocking issue", etc.>

### Findings

<For each category that has findings:>

#### 🔴 Correctness / 🟠 Security / 🟡 Code Quality / 🔵 Missing Tests / ⚪ Nits

**[filename:line]** — <issue title>
> `<quoted code>`
<Explanation of the problem and the suggested fix. Be specific.>

---

<If no blocking issues:>
✅ **Ready to merge** — no blocking issues found.

<If blocking issues exist:>
🚫 **Changes requested** — resolve blocking issues before merging.

## Step 5 — Offer inline comments

Ask the user: "Do you want me to post these findings as inline PR comments on GitHub? (`gh api` will be used)"

If yes, for each finding with a file + line number, post using:
```bash
gh api repos/{owner}/{repo}/pulls/<NUMBER>/comments \
  --method POST \
  --field body="<comment>" \
  --field commit_id="$(gh pr view <NUMBER> --json headRefOid -q .headRefOid)" \
  --field path="<file>" \
  --field line=<line>
```

Get owner/repo from: `gh repo view --json nameWithOwner -q .nameWithOwner`
