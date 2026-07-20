# Git Workflow

> **Applies to:** branching, commits, pull requests, and review — any git operation.

## Branches

- `main` is protected. Never push directly.
- Branch naming: `<type>/<short-description>` — e.g., `feat/user-avatar`, `fix/login-redirect`, `chore/update-deps`.
- Types: `feat`, `fix`, `chore`, `refactor`, `docs`, `test`.
- Delete branches after merge.

## Commits

Format: `<type>: <short imperative summary>` (max 72 chars)

```
feat: add avatar upload to profile page
fix: prevent double-submit on checkout form
chore: upgrade eslint to v9
```

- One logical change per commit.
- Present tense, imperative mood: "add" not "added", "fix" not "fixes".
- Reference issue/ticket in the body when relevant: `Closes #42`.
- Never commit: secrets, `.env`, `node_modules`, build artifacts, `console.log`.

## Pull Requests

- One concern per PR. If you're fixing a bug and you spot a refactor opportunity, open a separate PR.
- PR title follows the same format as commit messages.
- Fill in the PR description: what changed, why, and how to test it.
- All CI checks must pass before requesting review.
- Squash merge into `main` — keep the history clean.
- At least one approval required before merging.

## Code Review

- Review the diff, not just the final state.
- Suggest, don't dictate — use "consider" and "what do you think about" for non-blocking feedback.
- Blocking issues must be resolved before merge; non-blocking notes can be addressed in a follow-up.
- Don't approve PRs you haven't actually read.
