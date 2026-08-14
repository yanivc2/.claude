# Setup — {{PROJECT_NAME}}

Everything needed to go from a fresh clone to a running dev environment. Keep
this file current: if a setup step changes, update it in the **same** PR
(see `.claude/rules/documentation.md`).

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

`.env` is **never committed** (see `.claude/rules/security.md`). Copy the example and
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

- **`CLAUDE.md`** — project memory: always-on rules inline, plus an index of the path-scoped `.claude/rules/*.md`.
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

The conventions live in `.claude/rules/`. Each file carries a `paths:` block and
loads **only when Claude reads a matching file**, so they cost nothing at session
start. The always-on rules (secrets, git, verification) are inline in `CLAUDE.md`.

| File | Loads when reading |
|---|---|
| `.claude/rules/code-style.md` | any TypeScript / JavaScript file |
| `.claude/rules/python.md` | any `.py`, `requirements.txt`, `pyproject.toml` |
| `.claude/rules/frontend.md` | `.tsx` / `.jsx` / CSS, `components/` |
| `.claude/rules/backend.md` | `api/`, `server/`, `services/`, `migrations/`, `*.sql` |
| `.claude/rules/testing.md` | test files and test configs |
| `.claude/rules/security.md` | `api/`, `auth/`, `middleware.*`, manifests |
| `.claude/rules/error-handling-and-observability.md` | `api/`, `services/`, `workers/`, `.py` |
| `.claude/rules/performance.md` | `package.json`, build configs |
| `.claude/rules/documentation.md` | READMEs, `CLAUDE.md`, `docs/` |
| `.claude/rules/prompt-engineering.md` | `prompts/`, `llm/`, `*prompt*` |

**`main` is protected** — work on a `<type>/<desc>` feature branch and open a PR.
Git conventions are inline in `CLAUDE.md` (a path-scoped rule would never fire on
a git operation, since those don't read files).
