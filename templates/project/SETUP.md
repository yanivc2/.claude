# Setup — {{PROJECT_NAME}}

Everything needed to go from a fresh clone to a running dev environment. Keep
this file current: if a setup step changes, update it in the **same** PR
(see `rules/documentation.md`).

---

## Prerequisites

- **Node** {{NODE_VERSION}} (use `nvm`/`fnm` to match exactly).
- **Package manager:** {{PACKAGE_MANAGER}}.
- **Database:** {{DATABASE}} running locally or a reachable connection string.
- Git, and access to the project repository.

---

## 1. Install

```
git clone <repo-url>
cd {{PROJECT_NAME}}
{{PACKAGE_MANAGER}} install
```

## 2. Environment variables

`.env` is **never committed** (see `rules/security.md`). Copy the example and
fill in real values:

```
cp .env.example .env        # then edit .env with real values
```

- `.env.example` lists every required key with **no values**.
- Missing a required var? The app should fail fast at startup with a clear
  message — add the key to `.env.example` in the same change.

## 3. Run

```
{{PACKAGE_MANAGER}} run dev          — start dev server
{{PACKAGE_MANAGER}} run build        — production build
{{PACKAGE_MANAGER}} test             — run test suite
{{PACKAGE_MANAGER}} run lint         — lint
{{PACKAGE_MANAGER}} run typecheck    — TypeScript check
```

## 4. Verify the setup

Before your first commit, confirm the toolchain is healthy:

```
{{PACKAGE_MANAGER}} run typecheck
{{PACKAGE_MANAGER}} run lint
{{PACKAGE_MANAGER}} test
```

> This project ships hooks (in `.claude/settings.json`) that run **typecheck**
> and **ESLint/Prettier** automatically after each edit, and a session logger.
> They only surface warnings — they never block — so still run the full suite
> yourself before opening a PR.

---

## 5. Claude Code setup

This project was scaffolded from the global template, so it already contains:

- **`CLAUDE.md`** — project memory; imports the conventions in `rules/*.md`.
- **`.claude/settings.json`** — per-project hooks (typecheck, lint, session log).
- **`.mcp.json`** — the GitHub MCP server.

To finish wiring it up:

1. **GitHub MCP token.** On first use, Claude Code prompts for a
   `github_pat` (a GitHub Personal Access Token). Scope it to the minimum
   repos/permissions needed — never hard-code it anywhere.
2. **Before installing any skill, hook, or plugin — run `/install-review`.**
   This is a hard rule; nothing gets installed without the review first.
3. **Recommended skills** (optional, install after `/install-review`):

   ```
   npx skills add docx xlsx pdf pptx      # documents: quotes, invoices, reports
   npx skills add mcp-builder skill-creator
   ```

---

## Conventions

The full, opinionated conventions for this project live in `rules/` and are
imported by `CLAUDE.md`. Each file states when it applies:

| File | Applies to |
|---|---|
| `rules/code-style.md` | every file (always) |
| `rules/frontend.md` | React / UI work |
| `rules/backend.md` | server-side work |
| `rules/testing.md` | writing tests |
| `rules/git-workflow.md` | any git operation |
| `rules/security.md` | secrets, input, auth, deps |
| `rules/error-handling-and-observability.md` | errors, logging, monitoring |
| `rules/performance.md` | deps, bundle, rendering, images |
| `rules/documentation.md` | docs & comments |
| `rules/prompt-engineering.md` | LLM / prompt work |

**`main` is protected** — work on a `<type>/<desc>` feature branch and open a
PR (see `rules/git-workflow.md`).
