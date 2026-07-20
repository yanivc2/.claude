# {{PROJECT_NAME}}

{{PROJECT_DESCRIPTION}}

---

## Tech Stack

- Framework: {{FRAMEWORK}}
- Styling: {{STYLING_SOLUTION}}
- Backend: {{BACKEND}}
- Database: {{DATABASE}}
- Test runner: {{TEST_RUNNER}}
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

## Non-Negotiables

- Never commit secrets, API keys, or `.env` files.
- Never skip typechecking — run `{{PACKAGE_MANAGER}} run typecheck` after every non-trivial change.

> The full conventions live in the imported `rules/*.md` below (code style, security,
> git workflow, etc.) — this list is only the project-specific hard lines. Don't
> duplicate rule content here; add a bullet only for something unique to this project.

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

@../rules/code-style.md
@../rules/frontend.md
@../rules/backend.md
@../rules/testing.md
@../rules/git-workflow.md
@../rules/security.md
@../rules/error-handling-and-observability.md
@../rules/performance.md
@../rules/documentation.md
@../rules/prompt-engineering.md
