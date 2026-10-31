---
name: build-kit
description: Build kit — the order of work and the guides for building or improving a website or app, design included. Use when building, extending, fixing, refactoring or shipping a site or app.
---

# Build kit

Load by phase, not all at once. Most tasks need two or three of these, never all.

**Where these files are.** Usually `~/.claude/skills/<name>/SKILL.md`. Skills
synced from claude.ai sit one level deeper, at
`~/.claude/skills/synced/*/<name>/SKILL.md`. Read them with the Read tool.
The `superpowers:` skills come from the superpowers plugin: invoke them with the
Skill tool, or read
`~/.claude/plugins/cache/claude-plugins-official/superpowers/<version>/skills/<name>/SKILL.md`.

## The order

| Phase | Load | Skip it when |
|---|---|---|
| 1. Understand what is wanted | `superpowers:brainstorming` | the spec is already exact |
| 2. Turn it into steps | `superpowers:writing-plans` | it is a one-file change |
| 3. Write it | `superpowers:test-driven-development` | there is nothing to assert |
| 4. Something is broken | `superpowers:systematic-debugging` | nothing is broken |
| 5. Before merging | `superpowers:requesting-code-review` | — |
| 6. Before saying "done" | `superpowers:verification-before-completion` | never skip this one |

`karpathy-guidelines` is short and worth loading at step 3 on any task where the
code has to survive someone else reading it.

## Design is part of this

Anything with a user interface: load `design-kit` and follow its core A. Do not
design ad hoc inside a build task — the result drifts to generic.

## Stack-specific, only when it applies

| Stack | Load |
|---|---|
| React / Next.js performance | `vercel-react-best-practices` |
| Components that have grown unwieldy | `vercel-composition-patterns` |
| Web app that must feel native on a phone | `mobile-native` |
| Swift / iOS | `write-swift` (very large — load only for real Swift work) |
| Remotion video | `remotion-best-practices` |
| The UI needs hostile input thrown at it | `break-ui` |
| Local app needs driving and screenshotting | `webapp-testing` |

## Tools

`ToolSearch` by keyword; names differ per machine.

| Need | Search for |
|---|---|
| Drive a real browser, screenshot, click through | `playwright browser` |
| Deploys, build logs, runtime errors, env vars | `vercel deployment` |
| Database, migrations, SQL, edge functions | `supabase` |
| PRs, issues, CI status, review comments | `github pull request` |

Nothing found means the server is not configured here. Say so and continue.

## Hard rules

- **Verify from the artifact, not from the output that claims success.** A build
  that prints "done" and a test that was never run look identical in a log. Read
  the file, hit the endpoint, check the exit code.
- **Never claim a test passes without the output.** If it failed, show the failure.
- `main` is protected in the config repo and in most of these projects. Work on a
  branch; commit and push only when explicitly asked.
