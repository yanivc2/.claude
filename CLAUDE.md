# .claude — Global Claude Code Configuration

This repository **is** `~/.claude` (on the primary machine: `C:\Users\yaniv\.claude`).
Editing it changes Claude Code's own behavior on every session, so changes are
conservative and reviewed. It is not an application codebase — no build, no tests.

> This file is user-level memory: it loads in **every session in every project**.
> Keep it short. Repo-maintenance detail lives in `.claude/rules/config-repo.md`,
> which loads only when a config file is actually touched.

## Operating rules

1. **`/install-review` before installing any skill, hook, or plugin.** No exceptions.
2. **Never `commit` or `push` without an explicit request.**
3. **Explanations to the user are always in Hebrew.** Code, file contents, commit
   messages, and identifiers stay in English.

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

Windows + PowerShell. Every hook `command` is a PowerShell one-liner with
`"shell": "powershell"` and Windows path separators. A remote/Linux session cannot
execute them — edit them as text and validate the JSON instead of running them.

Active model: `opus` at `effortLevel: xhigh` (`settings.json`).

## Where things are

- `C:\Users\yaniv\Vault\INDEX.md` — the map of this machine: what exists, where it sits.
- To answer "what is on this machine", run `bin/qindex.mjs` — **never** Read the
  machine-index JSON directly (5 MB ≈ 1.3M tokens).
- `.claude/rules/config-repo.md` — how this repo is laid out and how to change it safely.
