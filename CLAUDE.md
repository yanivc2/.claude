# .claude — Global Claude Code Configuration

This repository **is** `~/.claude` on the Windows machine (`C:\Users\yaniv\.claude`)
and only there. Editing it changes Claude Code's own behavior on every session, so
changes are conservative and reviewed. It is not an application codebase — no
build, no tests.

> This file is user-level memory: it loads in **every session in every project**.
> Keep it short. Repo-maintenance detail lives in `.claude/rules/config-repo.md`,
> which loads only when a config file is actually touched.

## The two machines are separate

The Mac (`/Users/yanivcohen/.claude`) is its own git repository with **no remote**.
It was a clone of this one until 2026-10-22; it is not any more, and nothing syncs
between them in either direction. A change made here reaches the Mac only if
someone makes it there by hand. Each machine's `settings.json` carries only its own
platform's rules, so they are expected to differ and that is not drift.

## Operating rules

1. **`/install-review` before installing any skill, hook, or plugin.** No exceptions.
2. **Never `commit` or `push` without an explicit request.**
3. **Everything written to the user is in Hebrew** — replies, progress messages,
   questions (incl. `AskUserQuestion` options), plans and summaries (incl. compaction
   summaries). Code, file contents, commit messages, and identifiers stay in English.
   Enforced by `"language": "hebrew"` and a Stop hook (`hooks/hebrew-reply-hook.mjs`).
4. **One machine per session.** Both machines are reachable through Desktop
   Commander, which is not a reason to use both. Ask before starting work on the
   other one.

## Iron rules for files and folders

- **OneDrive: read allowed, write/move/rename/delete forbidden.** Files On-Demand
  placeholders are zero-byte; moving one severs it from its content. Reading one
  triggers a download, so read deliberately, never in bulk.
- **Code directories are never moved.** For logical placement use a junction:
  `cmd /c mklink /J "<link>" "<target>"`.
- **Nothing executes without an explicit GO** naming item numbers. A vague "ok" is
  not a GO — ask again.
- **No hard deletes.** Approved removals are staged into a `trash/` folder and
  emptied manually.
- **Hebrew files are written only with the Write/Edit tools** — never `Set-Content`,
  `Out-File`, or `>` (Windows PowerShell 5.1 writes BOM/UTF-16 and corrupts them).
- **Report failures immediately.** Never claim unverified success.

## Platform

Windows. 11 of the 12 hook `command`s run a Node script under `hooks/`
(`node "$HOME/.claude/hooks/<name>.mjs"`), so they are plain text a remote or
Linux session can safely edit. The exception is `context-mode-cache-heal`, which
hardcodes `C:/Program Files/nodejs/node.exe` and absolute Windows paths. No hook
is a PowerShell one-liner any more and no `"shell"` key is left.

Active model: `opus` at `effortLevel: xhigh` (`settings.json`).

## Where things are

- `C:\Users\yaniv\Vault\INDEX.md` — the map of this machine: what exists, what each
  thing does, where it sits. Answer "what is on this machine" from there. Its long
  records live beside it in `Vault\_organize\`.
- **Never Read a `machine-index*.json`** — 5 MB is roughly 1.3M tokens. It is denied
  in `settings.json` on purpose. The map is the Markdown, not the JSON.
- `.claude/rules/config-repo.md` — how this repo is laid out and how to change it safely.
