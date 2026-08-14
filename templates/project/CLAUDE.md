# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

---

## Tech Stack

- Framework: {{FRAMEWORK}}
- Styling: {{STYLING_SOLUTION}}
- Backend: {{BACKEND}}
- Database: {{DATABASE}}
- Test runner: {{TEST_RUNNER}} (component tests: {{COMPONENT_TEST_LIB}})
- Logger: {{LOGGER}}
- Error tracking: {{ERROR_TRACKER}}
- Node version: {{NODE_VERSION}}
- Package manager: {{PACKAGE_MANAGER}}

---

## Key Commands

```
{{PACKAGE_MANAGER}} run dev          — start dev server
{{PACKAGE_MANAGER}} run build        — production build
{{PACKAGE_MANAGER}} test             — run test suite
{{PACKAGE_MANAGER}} run lint         — lint
{{PACKAGE_MANAGER}} run typecheck    — TypeScript check (run after every change)
```

---

## Project Structure

```
src/
  components/    — reusable UI components
  pages/         — route-level pages
  lib/           — utilities and shared logic
  styles/        — global styles and design tokens
public/          — static assets
```

---

## Core Files

| File | Purpose |
|---|---|
| `src/lib/api.ts` | Central API client |
| `src/components/Layout.tsx` | Root layout and nav |
| `.env.example` | All required env vars (copy to `.env.local`) |

---

## Non-Negotiables (always in effect)

**Secrets**
- Never commit a secret, API key, or `.env` file. Never open, print, or echo one.
- Validate all external input at the boundary; authorize on the server, never the client.
- Treat any credential that was ever committed or pasted into a chat as compromised — rotate it.

**Git**
- `main` is protected. Work on `<type>/<short-desc>` branches.
- Commits: `<type>: <imperative summary>` (`feat`, `fix`, `chore`, `refactor`, `docs`, `test`).
- One concern per PR; squash merge.

**Verification**
- Run `{{PACKAGE_MANAGER}} run typecheck` after every non-trivial change. Never skip it.
- Report failures immediately; never claim unverified success.

> Everything else is a path-scoped rule (below) and loads only when relevant. Add a
> bullet here only for something unique to this project — don't duplicate rule content.

---

## Architecture Notes

<!-- Fill in for this project, or delete the section. Don't ship the placeholders. -->

- [Describe high-level data flow]
- [Note hard constraints]
- [Call out seams that are easy to break]

---

## Known Quirks

<!-- Fill in for this project, or delete the section. Don't ship the placeholders. -->

- [Surprising behaviors — high-value institutional memory]

---

## Automatic rules

These live in `.claude/rules/` and load **only when Claude reads a matching file** —
they cost nothing at session start. Listed here so you know they exist; don't
duplicate their content.

| Rule | Loads when reading |
|---|---|
| `code-style.md` | any `.ts` / `.tsx` / `.js` / `.jsx` file |
| `python.md` | any `.py` file, `requirements.txt`, `pyproject.toml` |
| `frontend.md` | `.tsx` / `.jsx` / CSS, or anything under `components/` |
| `backend.md` | `api/`, `server/`, `services/`, `migrations/`, `*.sql` |
| `testing.md` | test files and test configs |
| `security.md` | `api/`, `auth/`, `middleware.*`, dependency manifests |
| `error-handling-and-observability.md` | `api/`, `services/`, `workers/`, any `.py` |
| `performance.md` | `package.json`, build configs |
| `documentation.md` | READMEs, `CLAUDE.md`, `AGENTS.md`, `docs/` |
| `prompt-engineering.md` | `prompts/`, `llm/`, `*prompt*` files |

> `/compact` drops path-scoped rules until a matching file is read again. Prefer
> `/clear` and restarting in the subdirectory you're working in.

<!--
Cross-tool projects: make AGENTS.md the source of truth and reduce this file to the
single line `@./AGENTS.md`, so Codex and Gemini read the same instructions. Do not
use `mklink /H` — editors save by write-and-rename, which breaks a hardlink silently.
-->

