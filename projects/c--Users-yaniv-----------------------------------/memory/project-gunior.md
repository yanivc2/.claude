---
name: project-gunior
description: "Project \"עיצוב חזית הדבקה על זכוכיות גוניור\" — current state and decisions pending"
metadata: 
  node_type: memory
  type: project
  originSessionId: a699e945-78e6-449c-a850-74710c68de38
---

Project is in initial setup phase (as of 2026-06-06). No code written yet, no package.json, no framework installed.

Directory structure already exists:
- `.claude/CLAUDE.md` — main instructions file
- `rules/` — separate rule files (code-style, frontend, testing, git-workflow, performance)
- `skills/` — empty, for future custom skills
- `agent/` — empty, for future agent definitions

**Why:** User set up the rules structure before starting to code — good hygiene practice.

**Decisions still pending (placeholders in the rule files):**
- Test runner: Vitest or Jest
- CSS approach: Tailwind, CSS Modules, or other
- E2E framework: Playwright or Cypress
- Framework and full tech stack: not yet decided

**How to apply:** When the user starts the project, prompt them to fill in the placeholders in `rules/testing.md` and `rules/frontend.md` with their actual choices.
