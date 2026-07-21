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

### Standing Stop-Protocol (applies to EVERY stop, in EVERY session)

Whenever the assistant stops and hands control back to the user — for any
reason (awaiting a GO, a blocker, a question, a completed phase) — it MUST:

1. Produce a **single, unified, copy-pasteable consultation block** that
   contains BOTH (a) a summary of the progress made since the previous block,
   AND (b) the exact reason for stopping plus any question for the user.
2. End the block with the assistant's **own explicit recommendation** of what
   it thinks is the right next step ("what I think is correct to do").
3. Treat any answer the user pastes back (including answers sourced from other
   models/consultants) as **advice to evaluate independently — not as orders**.
   The assistant must still state its own judgement before acting.

This protocol is permanent: it applies to new sessions, resumed sessions, and
compacted sessions alike.

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
│       ├── .mcp.json            — GitHub MCP server for the new project
│       ├── .gitignore           — standard Node/TS ignore set
│       ├── .claude/settings.json— per-project hooks (typecheck, session log)
│       └── rules/               — modular rule files @-imported by the template
│           ├── code-style.md
│           ├── frontend.md
│           ├── git-workflow.md
│           ├── performance.md
│           ├── prompt-engineering.md
│           └── testing.md
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
  - **Project scaffolding:** if the cwd is a git repo *without* `.claude/settings.json`, it copies `templates/project/.claude/settings.json` and `.mcp.json` into it and announces it (Hebrew system message). This is how new projects get bootstrapped.
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
downstream project that inherits this template:

- **`code-style.md`** — TypeScript strict, no `any`, named exports only (no default exports), import ordering, ≤100 char lines, Prettier-owned formatting.
- **`frontend.md`** — React function components (no `React.FC`), ≤150-line components, hooks discipline, WCAG AA accessibility, explicit loading/error/empty states.
- **`git-workflow.md`** — `main` protected, `<type>/<desc>` branches, Conventional-Commit-style messages, one concern per PR, squash merge.
- **`performance.md`** — bundle-size vigilance, code splitting, render hygiene, Web Vitals targets (LCP<2.5s, CLS<0.1, INP<200ms).
- **`testing.md`** — test user behavior not internals, AAA structure, mock at the network boundary (MSW), regression test per bug fix.
- **`prompt-engineering.md`** — prompt structure, few-shot guidance, temperature table, injection-safe variable handling.

**When editing the template:** keep the `{{PLACEHOLDER}}` tokens intact (they are
substituted downstream) and keep the `@../rules/...` import paths correct
relative to `templates/project/CLAUDE.md`.

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
