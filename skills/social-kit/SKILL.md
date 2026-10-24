---
name: social-kit
description: Social kit — guides and tools for planning, writing, designing, scheduling and promoting content on social networks, for Israeli audiences. Use for posts, campaigns, paid ads or social analytics.
---

# Social kit

Load the core, then only the branch the task actually is. Marketing guides are
long; four of them at once drowns the brief.

**Where these files are.** Every skill named below is synced from claude.ai, so
it is **not** at `~/.claude/skills/<name>/`. It is one level deeper, at
`~/.claude/skills/synced/*/<name>/SKILL.md`. Read them with the Read tool.

## Core

`israeli-social-content` — what works per platform for an Israeli audience,
Hebrew copy, timing.

Add `sm-campaign-plan` when the task spans more than a single post: a cycle, a
launch, an experiment.

## Then the branch

| The task is | Load |
|---|---|
| Paid campaigns — Meta, Google, Taboola, Outbrain | `israeli-paid-ads` |
| Organic reach, search, being cited by AI engines | `hebrew-seo-geo-toolkit` |
| The visual itself — card, carousel, cover | `sm-visuals`, plus `canvas-design` for static art |
| Writing and scheduling for Store Management | `sm-social-content` |
| Email sequences rather than social | `israeli-email-sequences` |
| Asking the audience something | `hebrew-survey-builder` |

## Store Management work reads its own rules first

If the task is for Store Management, these files on the Windows machine are the
source of truth and override anything here:

- `C:\Users\yaniv\Store Management\רשתות חברתיות\00_BRAND_קווי_מותג.md` —
  positioning, and the content pillars (§1 and §4).
- `C:\Users\yaniv\Store Management\רשתות חברתיות\00_מצב_נוכחי.md` — what is
  scheduled, the standing rules, the running experiment and its posting hours.

Read them before writing anything. They change; this file does not.

## Tools

`ToolSearch` by keyword — the names differ between the Windows CLI, the desktop
app and a cloud session, and most of these exist only where claude.ai connectors
are available.

| Need | Search for |
|---|---|
| What is scheduled, what posted, reach and views | `metricool scheduled post` |
| Schedule or edit a post | `metricool create scheduled` |
| Generate video, reels, shorts | `higgsfield generate video` |
| Generate or edit a designed image | `canva design` |
| Send WhatsApp, templates, delivery reports | `whatsapp message` |
| Keyword, SERP and competitor data | `ahrefs keywords` |
| Cross-channel ad performance | `supermetrics data query` |

On the Windows CLI most of these are **not** configured — only
`whatsapp_business_tools` is, and it needs authentication. When `ToolSearch`
finds nothing, say which server is missing and continue without it.

## Hard rules

- **Never invent a number.** Reach, views and follower counts come from a tool
  response or they are not stated. "Not measured" is an acceptable answer.
- Planning and publishing are different acts. Do not schedule anything that was
  not explicitly approved.
