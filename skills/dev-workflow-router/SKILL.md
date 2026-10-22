---
name: dev-workflow-router
description: Index of the installed development workflow skills. Use when planning a feature, debugging, writing tests, reviewing code, working in git worktrees, or verifying work before claiming it is done.
---

# Development workflow skills: what is installed

Seventeen workflow skills are installed at `name-only`: Claude is shown the name
but pays nothing for a description until the skill is called. Most come from the
superpowers package. This index is what loads; run the skill yourself, or tell
the user which command to run.

Their directories live under `~/.agents/skills-tree/dev-workflow/`, grouped into
`planning/`, `quality/`, `agents/` and `git/`, with a symlink per skill in
`~/.claude/skills/` because Claude Code discovers skills at exactly one level.
The grouping is for reading the tree; what Claude sees is this index.

## Before writing code

| Need | Run |
|---|---|
| Explore the shape of a feature before building | `/brainstorming` |
| Turn a spec into a written multi-step plan | `/writing-plans` |
| Stress-test a plan or decision by interrogation | `/grilling` or `/grill-me` |
| Isolate feature work from the current workspace | `/using-git-worktrees` |

## While building

| Need | Run |
|---|---|
| Execute a written plan with review checkpoints | `/executing-plans` |
| Write the test before the implementation | `/test-driven-development` |
| Any bug, test failure or surprise, before fixing | `/systematic-debugging` |
| Independent tasks in the current session | `/subagent-driven-development` |
| Two or more tasks with no shared state | `/dispatching-parallel-agents` |

## Before claiming done

| Need | Run |
|---|---|
| About to say complete, fixed or passing | `/verification-before-completion` |
| Ask for review of finished work | `/requesting-code-review` |
| Handle review feedback, especially if it seems wrong | `/receiving-code-review` |
| Decide how to integrate a finished branch | `/finishing-a-development-branch` |

## Meta

| Need | Run |
|---|---|
| Create or edit a skill | `skill-creator`, always loaded |
| Verify a skill works before deployment | `/writing-skills` |
| Compact this conversation for another agent | `/handoff` |
| Reduce common LLM coding mistakes | `/karpathy-guidelines` |
| Static analysis | `/codeql`, `/semgrep`, `/sarif-parsing` |
| How skills work at all | `/using-superpowers` |

## The rules these encode, in one paragraph

Plan in writing before touching code. Write the failing test first. When something
breaks, find the cause before proposing a fix. Never claim work is complete without
running the check that proves it. Those four cover most of what the package says;
reach for a specific skill when the task is large enough that the detail matters.

## Note

`caveman` and its six companions are gone, not merely switched off. They carried
no description at all, and they rewrite every reply into a clipped style that
collides with the Hebrew-reply rule and with the writing standards here. The
directories were moved to `~/.agents/skills-archive/2026-10-22-empty-description/`
rather than deleted, so nothing is lost if they are ever wanted back.
