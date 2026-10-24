---
name: design-kit
description: Design kit — picks the right guide for designing or redesigning a page, image, site or app, and turns on the design tools. Use for design, restyle, polish, or visual critique.
---

# Design kit

Do not load everything here. Pick the job, load its core, add an extra only when
the work actually calls for it. Loading five style guides at once makes the
output worse, not better — they contradict each other on purpose.

**Where these files are.** Usually `~/.claude/skills/<name>/SKILL.md`. Skills
synced from claude.ai sit one level deeper, at
`~/.claude/skills/synced/*/<name>/SKILL.md` — `canvas-design` is one of them. If
the first path is not there, look there. Read them with the Read tool; a skill's
listing tier never stops its file being read.

## 1. Which job is this?

| The user wants | Load |
|---|---|
| A screen, page or app interface designed or restyled | **core A** below |
| A poster, card, image, PDF — static visual art | `canvas-design` |
| An existing site or app upgraded without a rewrite | `redesign-existing-projects` |
| A judgement on work that already exists | `impeccable` + `web-design-guidelines` |

## 2. Core A — interface design

Always: `impeccable` (what good means, and how to critique), then
`web-design-guidelines` (the checklist — short, load it).

Then **exactly one** style guide, chosen by the look that was asked for:

| If they said | Load |
|---|---|
| premium, agency, expensive, editorial-luxe | `high-end-visual-design` |
| clean, calm, editorial, warm monochrome | `minimalist-ui` |
| raw, industrial, terminal, tactical, dense data | `industrial-brutalist-ui` |
| Apple-like, fluid, physical | `apple-design` |
| nothing about style | ask which, or default to `minimalist-ui` |

## 3. Extras — only on demand

| Need | Load |
|---|---|
| Component polish, micro-detail, the craft bar | `emil-design-eng` (heavy) |
| Strict frontend taste while coding it | `design-taste-frontend` (heavy) |
| Motion and animation | start at `animate`; the full motion set is listed in `design-router` |
| Stress a component with worst-case data | `break-ui` |
| Make it feel native on a phone | `mobile-native` |
| Several versions behind a picker | `prototype` |
| Pick a UI library | `pick-ui-library` |

`prototype`, `pick-ui-library` and `review-animations` carry
`disable-model-invocation: true` — their authors meant them to run only when the
user asks for them by name. Reading them as plain text bypasses that, so do it
only on an explicit request.

## 4. Tools

Find them with `ToolSearch` by keyword, never by exact name: server names differ
between the Windows CLI, the desktop app and a cloud session.

| Need | Search for |
|---|---|
| Read a Figma file, push code to Figma | `figma design` |
| Reference UI from real shipped products | `mobbin collection` |
| Automated design and a11y review of code or a URL | `rams review` |
| Anthropic's own design server | `claude design` |
| Screenshot a live page to look at it | `playwright browser` |

If `ToolSearch` returns nothing, that server is not configured on this machine.
Say so in one line and carry on without it. Never describe what a tool "would"
have returned.

## 5. Before calling it done

Run the `web-design-guidelines` checklist against what was built. If a Rams tool
is available it takes seconds and catches what the eye slides past.
