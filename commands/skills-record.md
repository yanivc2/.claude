---
description: Record locally installed skills into skills-manifest.json so the other machine gets them
argument-hint: (none — reads what is installed)
---

# Record what was installed here

The SessionStart hook found skills installed on this machine that are not in
`skills-manifest.json`. Until they are recorded, the other machine will never
learn they exist.

Report everything in **Hebrew**.

## 1. Find the unrecorded skills

Read `~/.claude/skills-manifest.json`. List the directories in
`~/.claude/skills` — excluding `synced`, anything starting with a dot, and
anything in `ignore.skills`.

Anything not covered by a source's `skills` array is unrecorded. Skills under
`~/.claude/skills/synced/<bucket>/` are never unrecorded; they come from
claude.ai on their own.

## 2. Find each one's source

For each unrecorded skill, work out where it came from, in this order:

1. `~/.agents/skills/<name>/` exists → it came from the `skills` CLI. Check
   `~/.claude/skills/.antigravity-install-manifest.json`, which records the
   source repository per skill.
2. The skill's own `SKILL.md` frontmatter or README may name the repo.
3. Neither → ask the user. Do not guess a repository name; a wrong one sends
   the other machine to install something else entirely.

## 3. Propose the edit, then stop

Show the exact JSON you would add: either new skill names inside an existing
source, or a whole new source object with `id`, `repo`, `install` and `skills`.

Use the `--skill <name>` form in `install` rather than `--skill '*'` when only
some skills of a repo are wanted. The flag repeats; it does not take a
comma-separated list.

**Stop here and wait for a numbered GO.**

## 4. Write, only after GO

Edit `~/.claude/skills-manifest.json`, set `updatedAt` to today, and validate the
JSON. The file is tracked in git, so it only reaches the other machine after a
commit and push — say so explicitly, and do not commit without being asked.

## 5. If it should not travel

A skill that belongs on this machine alone goes into `ignore.skills` instead.
That silences the hook without pretending the skill is shared.

## 6. Finish

End with a Hebrew status block: what was recorded, what went to `ignore`, what
is still unknown, and the exact next command.
