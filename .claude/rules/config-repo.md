---
paths:
  - "settings.json"
  - ".mcp.json"
  - ".claude/settings.json"
  - "templates/**"
  - "commands/**"
  - "plugins/**"
---

# Working on the `~/.claude` config repo

> **Applies to:** editing this repository's own configuration — settings, hooks,
> templates, commands. Loaded on demand, not at session start.

## Repository Layout

```
.claude/                         (this repo == ~/.claude)
├── CLAUDE.md                    — lean user-level memory (loads everywhere; keep short)
├── settings.json                — GLOBAL settings: permissions + hooks + model
├── .mcp.json                    — MCP servers (github, playwright)
├── .gitignore                   — untracks secrets + ephemeral session data
├── session-log.md               — auto-generated session journal (Hebrew)
│
├── .claude/                     — repo-scoped config (active when cwd == this repo)
│   ├── settings.json            — nested hooks/permissions for working *in* this repo
│   └── rules/config-repo.md     — this file
│
├── commands/
│   ├── install-review.md        — /install-review (implements operating rule #1)
│   ├── organize-folders.md      — /organize-folders: staged cleanup + vault seeding
│   └── skills-audit.md          — /skills-audit: propose a skillOverrides block
│
├── plugins/
│   └── blocklist.json           — blocked plugins (name + reason)
│
├── templates/
│   ├── vault/                   — Obsidian-ready knowledge vault scaffold
│   └── project/                 — scaffold seeded into NEW projects
│       ├── CLAUDE.md            — placeholder-driven project memory template
│       ├── SETUP.md             — placeholder-driven onboarding guide
│       ├── .mcp.json            — GitHub MCP server for the new project
│       ├── .gitignore           — standard Node/TS ignore set
│       └── .claude/
│           ├── settings.json    — per-project hooks (typecheck, lint, session log)
│           └── rules/           — path-scoped rule files (see below)
│
└── shell-snapshots/             — captured shell env (gitignored)
```

## Two `settings.json` files — don't confuse them

| File | Scope | Purpose |
|---|---|---|
| `settings.json` (root) | **Global** — every session on this machine | Permission allowlist + deny rules, global hooks, model + effort. |
| `.claude/settings.json` | **This repo only** | Local overrides while editing the config itself: extra permissions, critical-rules banner, agent-based session recorder, typecheck hook. |

Claude Code merges the nearest `.claude/settings.json` with the global one.

## What the global hooks do (`settings.json`)

- **`SessionStart`**
  - **Project scaffolding:** in a git repo that has no `.claude/settings.json` **and**
    whose `origin` is this user's own, seeds from `templates/project/`. Every file is
    copied **only if absent** — nothing is ever force-overwritten. If a legacy
    project-root `rules/` directory exists, it emits a migration note (never deletes).
  - **Environment nudges:** warns on `package.json` without `node_modules`, or
    `.env.example` without `.env`.
- **`Stop`** — completion chime, `git diff HEAD --stat` summary, prunes `deletions/`
  older than 14 days.
- **`PreCompact`** — reminds Claude to persist TODOs/decisions before context is lost,
  and warns that path-scoped rules are dropped by `/compact`.
- **`PreToolUse`**
  - **OneDrive write guard:** blocks any `Write`/`Edit`/`Bash` operation targeting a
    OneDrive path. This is the *only* real enforcement of that iron rule —
    `Write()` entries in `permissions.deny` are accepted but never checked.
  - **Bash guard:** blocks `rm -rf`, `reset --hard`, `drop table`, and reads of
    `.env` / `session.json`.
  - **Write backup:** copies a file into `deletions/<timestamp>_<name>` before overwrite.
  - **Bash delete backup:** backs up `rm`/`Remove-Item` targets into `deletions/`.
- **`PostToolUse`** — typecheck after editing `.ts`/`.tsx` in a repo with `tsconfig.json`.

> `session-log.md` is auto-maintained by the Stop hook (kept under ~80 lines, entries
> older than 30 days trimmed). Don't hand-edit it.

## The project template (`templates/project/`)

Seeded into a new repo by the `SessionStart` hook. `CLAUDE.md` is
placeholder-driven — `{{PROJECT_NAME}}`, `{{FRAMEWORK}}`, `{{PACKAGE_MANAGER}}`,
`{{STYLING_SOLUTION}}`, `{{TEST_RUNNER}}`, `{{E2E_RUNNER}}`, `{{BACKEND}}`,
`{{DATABASE}}`, `{{LOGGER}}`, `{{ERROR_TRACKER}}`, `{{NODE_VERSION}}` — meant to be
filled in per project. Keep the tokens intact when editing.

### Rules are path-scoped, never imported

The template's rules live at `templates/project/.claude/rules/` and each carries a
`paths:` frontmatter block, so a rule loads **only when Claude Reads a matching
file**. This is deliberate and load-bearing:

- `@./rules/*.md` imports load **eagerly at launch** and do not reduce context —
  the old layout cost ~6,300 tokens in every session of every seeded project.
- Rules **without** a `paths:` block also load eagerly. Keep that set empty; anything
  genuinely always-on belongs inline in the project's `CLAUDE.md`.
- Path-scoped rules are **dropped by `/compact`** until a matching file is read again.
  Prefer `/clear` plus restarting in the relevant subdirectory over `/compact`.
- `paths:` triggers on the **Read tool only** — not on writing or creating files.

| Rule | Loads when |
|---|---|
| `code-style.md` | a TS/JS file is read |
| `python.md` | a `.py` file, `requirements.txt`, or `pyproject.toml` is read |
| `frontend.md` | a `.tsx`/`.jsx`/CSS file or anything under `components/` is read |
| `backend.md` | anything under `api/`, `server/`, `services/`, `migrations/`, or a `.sql` file |
| `testing.md` | a test file or test config is read |
| `security.md` | `api/`, `auth/`, `middleware.*`, or a manifest is read |
| `error-handling-and-observability.md` | `api/`, `services/`, `workers/`, or any `.py` |
| `performance.md` | `package.json` or a build config is read |
| `documentation.md` | a README/CLAUDE.md/AGENTS.md or anything under `docs/` |
| `prompt-engineering.md` | anything under `prompts/`, `llm/`, or a `*prompt*` file |

Git conventions are **not** a rule file: `paths:` never fires on git operations, so
they are inlined in the template's `CLAUDE.md` instead.

When adding a rule file: give it a `paths:` block, add a row above, and add its line
to the template `CLAUDE.md`'s "Automatic rules" index.

### Cross-tool instructions

This machine also runs Codex CLI and Gemini CLI. The convention is: `AGENTS.md` is the
single source of truth in each project, and `CLAUDE.md` contains the single line
`@./AGENTS.md`. Do **not** use `mklink /H` for this — editors save by writing a new
file and renaming over the old one, which breaks a hardlink silently and leaves two
divergent files. `.claude/rules/*.md` is Claude-only; note that in each `AGENTS.md`.

## The vault template (`templates/vault/`)

An Obsidian-ready knowledge vault seeded to `C:\Users\yaniv\Vault` by
`/organize-folders vault`. **Nothing here is ever force-copied** — seeding uses
`robocopy /E /XC /XN /XO`, which writes only files missing at the destination.
The vault is a local git repo so every organization round is recoverable.
`INDEX.md` is the heart: the map of what exists on this machine. Content Hebrew,
filenames English.

**Why `templates/vault/.claude/settings.json` exists:** the `SessionStart` seeder
fires in a git repo lacking `.claude/settings.json` and would install TypeScript
hooks in a folder holding no code. Shipping this file makes that guard fail.
**Do not delete it.**

`/organize-folders` runs in gated phases — `preflight → vault → scan → index →
propose → apply` — enforcing the iron rules from `CLAUDE.md`. It also handles the
Windows specifics: OneDrive-redirected Documents, registry-resolved Downloads, and
robocopy exit codes 0–7 meaning success.

## MCP servers (`.mcp.json`)

`github` (`@modelcontextprotocol/server-github` via `npx`, `github_pat` prompted
input — never hard-code it) and `playwright`. MCP tool schemas are deferred by
default, so servers cost little context; check per-server cost with `/mcp`.
`mcp-needs-auth-cache.json` is ephemeral runtime state, not configuration.

## Plugin blocklist (`plugins/blocklist.json`)

Entries carry `plugin`, `added_at`, `reason`, `text`. Add one (with a real reason) to
ban a plugin globally. Complements the `/install-review` requirement.

## Working on this repo

- **High blast radius.** A malformed `settings.json` breaks every session. Validate
  JSON after every edit.
- **Permissions:** add the *minimum* needed, and prefer the repo-scoped
  `.claude/settings.json` over the global list when the need is local.
  `permissions.deny` is the mechanism for excluding files — **`.claudeignore` does not
  exist.** Only `Read()` and `Edit()` path rules are actually checked.
- **Hooks are PowerShell.** Match the existing style and the `exit 0` convention so a
  hook failure never blocks a session.
- **Keep `CLAUDE.md` under 200 lines** — Anthropic's stated limit, and a bloated
  memory file causes Claude to ignore the rules that matter.
- **Don't commit secrets.** `.credentials.json`, `.env*`, and session/cache dirs are
  gitignored — keep them that way.
- **Ephemeral, don't over-track:** `shell-snapshots/`, `sessions/`, `file-history/`,
  `backups/`, `cache/`, `projects/`, `skills/`, `deletions/`.

## Git

Remote `https://github.com/yanivc2/.claude`, default branch `main`. **`main` is
protected** — work on a feature branch and only `commit`/`push` when explicitly asked.
Commits: `<type>: <imperative summary>` (`feat`, `fix`, `chore`, `refactor`, `docs`,
`test`), one logical change each.

<!-- last reviewed: 2026-08-14 -->
