---
name: remote-kit
description: Remote control kit — driving the Windows machine or the Mac from a session, running commands, spawning sessions and scheduled tasks. Use for remote control, Desktop Commander or another machine.
---

# Remote control kit

Everything here was learned by getting it wrong first. The traps are the point
of this file; the tool list is the easy part.

## The two machines

| | Windows | Mac |
|---|---|---|
| Path | `C:\Users\yaniv\.claude` | `/Users/yanivcohen/.claude` |
| Git | repo, pushes to `yanivc2/.claude` | local only, **no remote** |
| Shell | PowerShell 5.1 | zsh |

Since 2026-10-22 they are separate repositories. Nothing syncs between them in
either direction. A fix made on one does not reach the other.

**One machine per session.** Both are reachable, which is not a reason to use
both. Ask before starting work on the other one.

## Traps, in the order they bite

1. **The transport eats `$`.** A PowerShell one-liner sent through Desktop
   Commander loses `$` characters, so variables silently become empty. Write a
   `.mjs` file with `write_file` and run `node <path>` instead. Always.
2. **PowerShell 5.1 is not bash.** `&&` is not a statement separator. `2>/dev/null`
   creates `C:\dev\null` and fails. `<` redirection is unsupported. Write Node,
   not shell.
3. **PowerShell 5.1 reads `.ps1` as ANSI.** Hebrew inside a script file breaks
   parsing. Write such files with `write_file` or Node, never `Set-Content`,
   `Out-File` or `>`.
4. **Installer output lies.** `npx skills add` prints `Failed to install 1` while
   the install succeeded — a different target failed. Verify from disk: does the
   file exist, does it parse, is the symlink resolvable. Never report success from
   a success message.
5. **`isDirectory()` is false for a symlink.** Most entries under
   `~/.claude/skills` are symlinks into `~/.agents/skills`. A scan using
   `readdirSync(..., {withFileTypes:true})` and `isDirectory()` silently misses
   them. Test `existsSync(dir + '/SKILL.md')` instead.
6. **`npx` eats stdin.** A `while read … < file` loop with `npx` inside consumes
   the loop's own input and runs one iteration while reporting success for all.
   Redirect with `</dev/null`, or use `stdio: ['ignore','pipe','pipe']`.
7. **Long commands are not finished when `start_process` returns.** It returns
   initial output only. Call `read_process_output` until it reports completion.
8. **Session transcripts are huge.** One line can exceed a megabyte. Measure with
   `wc -lc` first, extract fields with `sed -n Np` and `jq`; never `cat` or
   `grep` one for content.

## Tools

`ToolSearch` by keyword — names differ per surface.

| Need | Search for |
|---|---|
| List the machines, see which are online | `desktop commander devices` |
| Run a command, read its later output | `desktop commander process` |
| Write or patch a file on a machine | `desktop commander write file` |
| Search a machine's filesystem | `desktop commander search` |
| Start a session elsewhere, message it | `claude code remote session` |
| Scheduled tasks — list and repair | `claude code remote trigger` |
| Drive the person's own desktop, click and type | `computer use` |
| A browser with their logins | `chrome browser` or `built-in browser` |

Load `computer-use`, `chrome-browser` or `built-in-browser` before the first
step that uses them — each has rules about permissions and what it must not
touch. All three are synced from claude.ai, so they are **not** at
`~/.claude/skills/<name>/`; they are at `~/.claude/skills/synced/*/<name>/SKILL.md`.

## Scheduled tasks

The allowlist permits **listing and updating** them, not creating or deleting.
That is deliberate: a session should be able to repair a broken routine, and
should not be able to silently remove a schedule. A broken routine is fixed with
`update_trigger` on its prompt, never by delete-and-recreate — that loses its run
history.

## Hard rules

- **Report failures immediately.** Never claim unverified success.
- **No hard deletes.** Approved removals go to a `trash/` folder.
- **OneDrive: read only.** Writing, moving or renaming severs a placeholder from
  its content. A PreToolUse hook enforces this; do not try to route around it.
- Nothing executes on a machine without an explicit go-ahead naming what runs.
