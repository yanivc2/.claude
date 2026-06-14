---
description: Bootstrap a new project with full Claude Code setup — CLAUDE.md, rules, hooks, git init, and initial commit. Run this once in a new empty project directory.
---

When this skill is invoked, follow these steps exactly:

## Step 1 — Collect project info

Use the AskUserQuestion tool to collect (in one call, up to 4 questions):
1. Project name (short, in Hebrew or English — used in CLAUDE.md heading)
2. One-line description (purpose + target audience)
3. Tech stack: framework, styling, package manager (e.g. "Next.js 15, Tailwind, npm")
4. Node version (e.g. "20.x") — if unknown, use "20.x"

## Step 2 — Copy template files

Run this PowerShell command to copy the full template into the current working directory:

```powershell
Copy-Item -Path "$env:USERPROFILE\.claude\templates\project\*" -Destination "." -Recurse -Force
```

## Step 3 — Fill in CLAUDE.md placeholders

Read the copied `CLAUDE.md` and replace all placeholders with the user's answers:
- `{{PROJECT_NAME}}` → project name from step 1
- `{{PROJECT_DESCRIPTION}}` → one-line description from step 1
- `{{FRAMEWORK}}` → framework from tech stack
- `{{STYLING}}` → styling from tech stack
- `{{BACKEND}}` → backend if mentioned, otherwise "TBD"
- `{{NODE_VERSION}}` → node version from step 1
- `{{PACKAGE_MANAGER}}` → package manager from step 1 (npm / pnpm / yarn)

## Step 4 — Initialize git

```powershell
git init
git add .gitignore .claude/ rules/ CLAUDE.md
git commit -m "chore: bootstrap project from template"
```

## Step 5 — Report

Tell the user:
- What was created (CLAUDE.md, rules/, .claude/settings.json, .gitignore)
- That hooks are active: Stop (beep), PreCompact (context reminder), PostToolUse typecheck, PreToolUse destructive guard
- That `fileCheckpointingEnabled` is already on globally — `/rewind` is available
- Next step: fill in Architecture Notes and Known Quirks in CLAUDE.md as they learn the project

## Notes

- The PostToolUse typecheck hook runs `npm run typecheck`. If the project uses pnpm or yarn, update `.claude/settings.json` after bootstrap.
- The template rules/ files cover: code-style, frontend, testing, git-workflow, performance, prompt-engineering.
- Do NOT create a README unless the user explicitly asks.
