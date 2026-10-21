---
description: Install the skills this machine is missing from skills-manifest.json
argument-hint: (none — reads the manifest)
---

# Install the missing skills

The SessionStart hook `hooks/skills-drift.mjs` reported that skills listed in
`skills-manifest.json` are not installed on this machine. Close the gap.

Report everything in **Hebrew**.

## 1. Recompute the gap

Do not trust the hook's message; it may be from the start of the session.
Read `~/.claude/skills-manifest.json` and list the directories in
`~/.claude/skills` plus every directory under `~/.claude/skills/synced/<bucket>/`.

A skill counts as present if it appears in either place. Skills in the
manifest's `ignore.skills` are never missing.

## 2. Show the plan, then stop

List what is missing, grouped by source, with the exact install command for each
group taken verbatim from the manifest's `install` field. Show the total count.

**Stop here and wait for a numbered GO** — repo operating rule: nothing executes
without an explicit GO naming item numbers.

## 3. Install, only after GO

Run one install command per source. Two things about the `skills` CLI:

- It finishes with a message like `Failed to install 15 → PromptScript does not
  support global skill installation`. **That message is misleading.** Only the
  PromptScript target failed; Claude Code succeeded.
- So never trust the exit code. Verify against the filesystem instead.

## 4. Verify

For each skill that should now exist, confirm `~/.claude/skills/<name>/SKILL.md`
is readable. Report the count that landed and the count that did not.

On Windows, a junction needs Developer Mode or an elevated shell. If
`~/.agents/skills/` filled up but `~/.claude/skills/` did not, that is the cause —
say so plainly rather than reporting success.

## 5. Decide the tier

A newly installed skill defaults to auto-trigger, and every auto-trigger
description eats from a budget that is already near its limit
(`skillListingMaxDescChars` is 200, and roughly 34 skills are on).

So for each new skill, propose one of:

- **on** — needed in most conversations in its domain
- **user-invocable-only** — niche; reachable with `/name`, costs nothing
- **off** — redundant, broken, or conflicting

Default to `user-invocable-only` and add a line to the matching router
(`skills/design-router/` or `skills/dev-workflow-router/`) so it stays
discoverable. Write the choice into `skillOverrides` in `~/.claude/settings.json`
only after a GO, and validate the JSON afterwards.

## 6. Finish

End with a Hebrew status block: what was installed, what tier each got, what
failed, and whether `skills-manifest.json` needs a commit.
