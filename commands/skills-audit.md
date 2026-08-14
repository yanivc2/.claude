---
description: Measure the installed-skill surface and propose a skillOverrides block that restores auto-triggering
argument-hint: <measure | propose | apply — empty for measure>
---

# Skills audit

Roughly a thousand skills are installed on this machine. The cost model is not
the obvious one, and it drives everything below:

- Only **name + description** load at session start — never the skill body.
- Descriptions share a budget of **1% of the context window**. When it overflows,
  Claude Code **truncates descriptions**, dropping the least-used first.
- **Names always load, with no cap.**

So the damage is not only tokens: past a few hundred skills the descriptions are
truncated so hard that most skills **can no longer auto-trigger at all**. You pay
for names you cannot use. Fixing this is mostly about restoring retrieval, and
the token saving is a bonus.

**Phase:** $ARGUMENTS

Report everything in **Hebrew**. **Change nothing before section 3.**

## 1. measure

- `/context` — record the **Skills** line, and the total.
- `/doctor` — record its estimate of the listing's cost, its biggest
  contributors, and whether it reports descriptions being truncated.
- `/usage` — record the attribution section: which skills, plugins and MCP
  servers were actually used.
- Count what is installed:
  ```powershell
  (Get-ChildItem "$env:USERPROFILE\.claude\skills" -Directory -ErrorAction SilentlyContinue).Count
  (Get-ChildItem "$env:USERPROFILE\.agents\skills" -Directory -ErrorAction SilentlyContinue).Count
  ```
  If `~/.claude/skills` is a link, resolve it — the two may be the same set:
  ```powershell
  (Get-Item "$env:USERPROFILE\.claude\skills").LinkType
  ```
- Establish the floor for comparison: run `claude --safe-mode` in the same
  directory and `/context` again. The difference is what all customization costs.

Report the numbers as a table. This is the baseline every later claim is measured
against — without it, "improved" is an opinion.

## 2. propose

Build a keep-list and show it **before** touching anything.

Rank candidates by evidence, in this order:

1. **Used** — anything in `/usage` attribution, or invoked in the session
   transcripts under `~/.claude/projects/`. Auto-keep.
2. **Domain fit** — this user runs four supermarkets in Israel plus a SaaS
   venture, and builds Next.js/Node and Python tools. Keep: the Israeli
   business/tax/HR/compliance and Hebrew-content skills, the Office document
   skills, the Claude Code tooling skills, and the stacks actually in use.
3. **Broken by construction** — a skill whose `SKILL.md` has no `description`
   can never auto-trigger. It costs a name and returns nothing.
4. **Foreign domain** — other countries' legal/consulting skills, offensive
   security, SaaS connectors that aren't used, one-off verticals. Archive.

Then split the keepers into two tiers, because a flat keep-list of 100 still
overflows the description budget:

| Tier | Setting | Cost |
|---|---|---|
| auto-trigger (~60) | `"on"` + a description under 200 chars | name + description |
| slash-only (~40) | `disable-model-invocation: true` in frontmatter | **zero** until `/name` |
| archived (the rest) | `"off"` in `skillOverrides` | name only, or nothing |

Present the proposed `skillOverrides` map and the `skillListingMaxDescChars`
value, and **STOP for an explicit GO**. Do not write to settings.

> `disabledSkills` is not a real setting — the key is `skillOverrides`, with
> values `on` / `name-only` / `user-invocable-only` / `off`.

## 3. apply — only after GO

- Write `skillOverrides` and `"skillListingMaxDescChars": 200` into
  `~/.claude/settings.json`. Validate the JSON before finishing.
- This is a **settings change only** — no skill folder is moved or deleted, so
  it reverses by editing one file.
- Re-run `/context` and report the delta against the baseline from section 1.
- **Verify the assumption:** it is documented that `off` disables a skill, but
  not whether the name also leaves the listing. If the Skills line did not drop
  roughly in proportion, say so plainly — the remaining cost is names, and only
  moving folders to `~/.agents/skills-archive\` (a sibling, never a child, and a
  move, never a delete) recovers it.
- Rewrite the descriptions of the auto-trigger tier so the trigger words land in
  the first 200 characters. Truncation cuts the tail; a description whose trigger
  vocabulary sits in sentence three is dead weight.

## Output contract

End with a Hebrew status block: baseline numbers, what changed, the measured
delta, what is still outstanding, and the exact next command.
