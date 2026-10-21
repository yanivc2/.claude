---
name: design-router
description: Index of the installed design skills. Use when the task involves UI, visual design, animation, motion, typography, layout, polish, or making an interface feel premium or native.
---

# Design skills: what is installed and when to reach for it

Twenty-three design skills are installed at `name-only`: Claude is shown the name
but pays nothing for a description until the skill is called. This index is what
loads. Read the row, then either run the skill yourself or tell the user the
exact slash command.

## Motion and animation

| Need | Run |
|---|---|
| Build an animation from scratch, in decision order | `/animate` |
| Same for React Native and Expo | `/animate-expo` |
| Keep animation inside the frame budget | `/animation-performance` |
| Name a motion effect from a vague description | `/animation-vocabulary` |
| Find places that should animate but do not | `/find-animation-opportunities` |
| Audit a codebase's motion, produce a plan | `/improve-animations` |
| Review motion against a strict craft bar | `/review-animations` |

Core principles, so you can answer without loading any of them: animate transform
and opacity only; scroll-driven motion must be a pure function of progress so it
reverses; entrances ease out, movement eases in and out; every autoplaying loop
needs a visible pause control; `prefers-reduced-motion` shows the end state, not
a faster animation.

## Visual language

| Need | Run |
|---|---|
| Expensive agency-grade interfaces | `/high-end-visual-design` |
| Clean editorial, warm monochrome | `/minimalist-ui` |
| Raw industrial, rigid grid, terminal | `/industrial-brutalist-ui` |
| Upgrade an existing site without breaking it | `/redesign-existing-projects` |
| Check against Web Interface Guidelines | `/web-design-guidelines` |

## Components and frontend

| Need | Run |
|---|---|
| Pick the right library for a frontend task | `/pick-ui-library` |
| Build several versions behind a picker | `/prototype` |
| Stress a component with worst-case data | `/break-ui` |
| Toast library questions | `/ask-sonner` |
| Make a web app feel native on a phone | `/mobile-native` |
| React and Next.js performance | `/vercel-react-best-practices` |
| Composition patterns that scale | `/vercel-composition-patterns` |
| Remotion video | `/remotion-best-practices` |
| Modern Swift | `/write-swift` |

## Static output: posters, art, standalone pages

| Need | Run |
|---|---|
| A poster, flyer, cover or other visual piece as PNG or PDF | `/canvas-design` |
| A standalone HTML page or web artifact, built to be looked at | `/web-artifacts-builder` |

These two produce a finished file rather than code in a project, so reach for them
when the deliverable is the artwork itself. `/canvas-design` composes original
work only — never a copy of a named artist's style.

## Always loaded, no command needed

`emil-design-eng` for UI polish philosophy, `apple-design` for Apple's motion and
material thinking, `impeccable` for critique and distillation, and
`design-taste-frontend` for anti-generic frontend work. These four stay on because
they apply to most design conversations.

## Two warnings

`prototype` opens with a fixed English sentence it insists on repeating verbatim,
which collides with the Hebrew-reply rule. Translate it rather than pasting it.

`high-end-visual-design` and `emil-design-eng` cover overlapping ground and are
both strongly opinionated. If two answers contradict each other, that is why.
Pick one for the task instead of blending them.
