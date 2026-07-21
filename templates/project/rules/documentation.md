# Documentation

> **Applies to:** README, code comments, API docs, and this project's `CLAUDE.md` — keep them true as the code changes.

## README

Every project's `README.md` answers, near the top:

- **What** it is — one or two sentences.
- **Setup** — clone → install → env vars → run, as copy-pasteable commands.
- **Key scripts** — dev, build, test, lint, typecheck.
- **Architecture** — a short paragraph or diagram of the main pieces and data flow.

Keep it current: if a setup step changes, the README changes in the **same** PR.

## Code Comments

- Comment the **why**, never the **what** — the code already says what (see `code-style.md`).
- Public/exported functions with non-obvious behavior get a short doc comment (JSDoc/TSDoc): purpose, params, return, thrown errors.
- Delete stale comments in the same edit that makes them stale. A wrong comment is worse than none.
- No commented-out code — git has the history.

## Keeping `CLAUDE.md` True

- `CLAUDE.md` is memory for the AI — treat drift as a bug. When structure, commands, or conventions change, update it in the same change.
- Record durable decisions and gotchas under **Architecture Notes** / **Known Quirks** — this is high-value institutional memory, not filler.
- Prefer linking to a rule file over duplicating its content (single source of truth).

## API / Interface Docs

- Document public API endpoints: method, path, request shape, response shape, error codes.
- Keep the docs next to the code (or generated from it) so they can't silently drift.
- Provide at least one realistic request/response example per endpoint.

## Changelog & Commits

- The commit history is documentation — write meaningful messages (see `git-workflow.md`).
- For released/versioned projects, maintain a `CHANGELOG.md` (Keep a Changelog format) grouped by version.

## Non-Negotiables

- Docs change in the same PR as the behavior they describe.
- No stale comment or `CLAUDE.md` section left behind after a change.
