# .claude — Global Claude Code Configuration

This repository **is** the user's global Claude Code home directory
(`~/.claude`, which on the primary machine is `C:\Users\yaniv\.claude`). It is
version-controlled so the configuration can be reviewed, rolled back, and
synced across machines. It is **not** an application codebase — there is no
build, no test suite, and no runtime app here. The "product" is the set of
settings, hooks, permissions, MCP servers, and project templates that shape how
Claude Code behaves on this user's machine.

Treat every change here as a change to Claude Code's own behavior. A broken hook
or an over-broad permission affects *every* session on this machine, so changes
must be conservative and reviewed.

---

## Operating Conventions (read first)

These come from the machine's own `SessionStart` hook and are the top-priority
rules for any session:

1. **`/install-review` is mandatory before installing any skill or hook.** Never
   add a hook, skill, or plugin without running the review first.
2. **Never `commit` or `push` without an explicit request** from the user.
3. **Explanations are always in Hebrew** (`הסברים תמיד בעברית`). Code, file
   contents, commit messages, and identifiers stay in English; prose
   explanations to the user are in Hebrew unless they ask otherwise.

The active model is **`opus`** at **`effortLevel: xhigh`** (`settings.json`).

---

## Platform Notes

- **The user's primary environment is Windows + PowerShell.** Almost every hook
  `command` in `settings.json` is a PowerShell one-liner and assumes paths like
  `C:\Users\yaniv\...`, `winsound`, `Get-ScheduledTask`, etc.
- Hooks specify `"shell": "powershell"` explicitly. When editing or adding
  hooks, write **PowerShell**, not bash, and use Windows path separators.
- This remote/CI Linux environment (where an AI assistant may edit these files)
  cannot execute the PowerShell hooks. Edit them as text; do not try to run or
  "verify" them by executing — validate JSON structure instead.

---

## Repository Layout

```
.claude/                         (this repo == ~/.claude)
├── CLAUDE.md                    — this file
├── settings.json                — GLOBAL settings: permissions + hooks + model
├── .mcp.json                    — MCP servers (GitHub server via npx)
├── .gitignore                   — untracks secrets + ephemeral session data
├── mcp-needs-auth-cache.json    — cache of MCP servers awaiting auth (ephemeral)
├── session-log.md               — auto-generated session journal (Hebrew)
│
├── .claude/                     — repo-scoped settings (apply when cwd == this repo)
│   └── settings.json            — nested hooks/permissions for working *in* this repo
│
├── plugins/
│   └── blocklist.json           — blocked plugins (name + reason)
│
├── templates/
│   └── project/                 — scaffold copied into NEW projects (see below)
│       ├── CLAUDE.md            — placeholder-driven project memory template
│       ├── SETUP.md            — placeholder-driven onboarding / setup guide
│       ├── .mcp.json            — GitHub MCP server for the new project
│       ├── .gitignore           — standard Node/TS ignore set
│       ├── .claude/settings.json— per-project hooks (typecheck, lint, session log)
│       └── rules/               — modular rule files @-imported by the template
│           ├── code-style.md
│           ├── frontend.md
│           ├── backend.md
│           ├── testing.md
│           ├── git-workflow.md
│           ├── security.md
│           ├── error-handling-and-observability.md
│           ├── performance.md
│           ├── documentation.md
│           └── prompt-engineering.md
│
├── ide/                         — IDE lock files (ephemeral, tracked snapshot)
└── shell-snapshots/             — captured shell env (gitignored)
```

### Two `settings.json` files — don't confuse them

| File | Scope | Purpose |
|---|---|---|
| `settings.json` (root) | **Global** — every session on this machine | Master permission allowlist, global hooks (SessionStart scaffolding, Stop chimes + logging + backup pruning, PreToolUse safety guards, PostToolUse typecheck), model + effort. |
| `.claude/settings.json` | **This repo only** — active when cwd is `~/.claude` | Local overrides used while editing the config itself: extra read/PowerShell permissions, the critical-rules banner, an agent-based session recorder, a typecheck PostToolUse. |

Claude Code merges the nearest `.claude/settings.json` with the global one, so
both are live when working inside this directory.

---

## What the Global Hooks Do (`settings.json`)

Understanding these is essential before editing — they run automatically.

- **`SessionStart`**
  - **Project scaffolding:** if the cwd is a git repo *without* `.claude/settings.json`, it seeds the project from `templates/project/`: `.claude/settings.json` and `.mcp.json` are copied (overwriting), and `CLAUDE.md`, `SETUP.md`, `rules/`, and `.gitignore` are copied **only if absent** (never clobbering an existing file). It announces the result via a Hebrew system message. This is how new projects get bootstrapped.
  - **Environment nudges:** warns if `package.json` exists but `node_modules` is missing, or if `.env.example` exists but `.env` does not.
- **`Stop`** (fires when Claude finishes a turn)
  - Plays `tada.wav` (audible completion chime).
  - Emits a compact `git diff HEAD --stat` summary as a system message.
  - Prunes files older than 14 days from the `deletions/` backup folder.
- **`PreCompact`** — reminds Claude to persist open TODOs, decisions, and lessons to `CLAUDE.md`/`rules/` before context is lost.
- **`PreToolUse`**
  - **`Bash` guard:** blocks commands matching `rm -rf`, `reset --hard`, or `drop table`.
  - **`Write` backup:** before overwriting an existing file, copies the old version into `deletions/<timestamp>_<name>`.
  - **`Bash` delete backup:** before an `rm`/`Remove-Item`, backs up each targeted existing file into `deletions/`.
- **`PostToolUse`** — after `Edit`/`Write` of a `.ts`/`.tsx` file in a repo with a `tsconfig.json`, runs `npx tsc --noEmit` and surfaces the first few errors.

The repo-scoped `.claude/settings.json` adds: a **critical-rules banner** on
session start (the three rules above), an **agent-type Stop hook** that silently
writes an entry to `session-log.md`, and a typecheck-on-edit hook.

> Note: `session-log.md` is committed here but the *template's* `.gitignore`
> marks `.claude/session-log.md` as local-only. The log is auto-maintained
> (kept under ~80 lines, entries older than 30 days trimmed) — don't hand-edit
> it; let the Stop hook manage it.

---

## The Project Template (`templates/project/`)

This is the single most important asset to understand. When Claude starts a
session in a **new** git repo, the global `SessionStart` hook seeds that repo
from here. The template's `CLAUDE.md` is **placeholder-driven** — it contains
`{{PROJECT_NAME}}`, `{{FRAMEWORK}}`, `{{PACKAGE_MANAGER}}`, etc., meant to be
filled in per project, and it `@`-imports the six `rules/*.md` files.

The `rules/` files encode this user's opinionated defaults. Honor them in any
downstream project that inherits this template. Each file opens with an
`> **Applies to:**` line stating when it's relevant:

- **`code-style.md`** — *always in effect.* TypeScript strict, no `any`, named exports only (no default exports), import ordering, ≤100 char lines, Prettier-owned formatting.
- **`frontend.md`** — *React/UI work.* Function components (no `React.FC`), ≤150-line components, hooks discipline, WCAG AA accessibility, explicit loading/error/empty states.
- **`backend.md`** — *server-side work.* REST resource design, correct status codes, thin handlers → service → data-access layering, migrations for every schema change, timeouts on outbound calls.
- **`testing.md`** — *writing tests.* Test user behavior not internals, AAA structure, mock at the network boundary (MSW), regression test per bug fix.
- **`git-workflow.md`** — *any git op.* `main` protected, `<type>/<desc>` branches, Conventional-Commit-style messages, one concern per PR, squash merge.
- **`security.md`** — *secrets, input, auth, deps.* No secret in git, validate all input at the boundary, authorize on the server, hash passwords, `audit` dependencies.
- **`error-handling-and-observability.md`** — *errors, logging, monitoring.* No silent catches, structured logging (no `console.log`), no secrets/PII in logs, unhandled exceptions reach an error tracker, health endpoints.
- **`performance.md`** — *deps/bundle/render/images.* Bundle-size vigilance, code splitting, render hygiene, Web Vitals targets (LCP<2.5s, CLS<0.1, INP<200ms).
- **`documentation.md`** — *docs & comments.* README kept current in the same PR, comment the *why*, keep `CLAUDE.md` true, document API interfaces.
- **`prompt-engineering.md`** — *LLM/prompt work.* Prompt structure, few-shot guidance, temperature table, injection-safe variable handling.

**When editing the template:** keep the `{{PLACEHOLDER}}` tokens intact (they are
substituted downstream — e.g. `{{STYLING_SOLUTION}}`, `{{TEST_RUNNER}}`,
`{{BACKEND}}`, `{{DATABASE}}`, `{{LOGGER}}`, `{{ERROR_TRACKER}}`) and keep the
`@./rules/...` import paths correct — they resolve relative to `CLAUDE.md`'s own
directory, so `@./rules/` works both in `templates/project/` and once the file is
copied to a project root (rules land at `<project>/rules/`).
When you add a rule file, add its `@import` line to the template **and** list it here.

---

## MCP Servers (`.mcp.json`)

- **`github`** — `@modelcontextprotocol/server-github` via `npx`, authenticated
  with a `github_pat` prompted input (never hard-code the token).
- `mcp-needs-auth-cache.json` tracks MCP servers still awaiting authentication;
  it is ephemeral runtime state, not configuration to edit by hand.

---

## Plugin Blocklist (`plugins/blocklist.json`)

A list of plugins that must not be installed, each with `plugin`, `added_at`,
`reason`, and `text`. Add an entry here (with a real reason) to ban a plugin
globally. This complements the `/install-review` requirement.

---

## Working On This Repo

- **Editing config is high-blast-radius.** A malformed `settings.json` can break
  every session. After any edit to a `settings.json` or `.mcp.json`, validate it
  is well-formed JSON before finishing.
- **Permissions:** the global `allow` list is intentionally narrow and mostly
  Windows/PowerShell-specific. Add the *minimum* permission needed; prefer
  scoping to the repo-level `.claude/settings.json` over the global list when the
  need is local to editing this config.
- **Hooks are PowerShell.** Match the existing style, quoting, and `exit 0`
  convention (most hooks end with `exit 0` so a hook failure never blocks the
  session).
- **Don't commit secrets.** `.credentials.json`, `.env*`, and session/cache
  directories are gitignored — keep them that way.
- **Ephemeral, don't over-track:** `shell-snapshots/`, `sessions/`,
  `file-history/`, `backups/`, `cache/`, `projects/`, `skills/`, and
  `deletions/` are gitignored on purpose (skills are reinstallable via
  `npx skills`). Don't re-add them to version control.

### Git

- Remote: `https://github.com/yanivc2/.claude`, default branch `main`.
- **`main` is protected — do not push to it.** Work on the designated feature
  branch and only `commit`/`push` when explicitly asked (rule #2 above).
- Follow the same commit conventions the template enforces:
  `<type>: <imperative summary>` (`feat`, `fix`, `chore`, `refactor`, `docs`,
  `test`), one logical change per commit.

---

<!-- last reviewed: 2026-07-20 — verify this doc against the actual repo state when it drifts -->

