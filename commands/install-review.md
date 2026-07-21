---
description: Mandatory security review of a skill/hook/plugin before installing it (repo rule #1)
argument-hint: <skill | hook | plugin name or source>
---

# Pre-install security review

A skill, hook, or plugin is about to be installed on this machine. Per the #1
operating rule of this `~/.claude` config, nothing gets installed until this
review passes. **Do not install anything during this review — only assess.**

**Target under review:** $ARGUMENTS

Work through every step and report the findings in **Hebrew**:

## 1. Identify

- What exactly is being installed — name, version, source/publisher, URL or npm package?
- Where would it land (global `~/.claude` vs a specific project) and what type is it (skill / hook / plugin / MCP server)?
- If the target is unclear from "$ARGUMENTS", ask the user before continuing.

## 2. Blocklist check

- Read `plugins/blocklist.json`. If the target (or its marketplace) matches an entry, **STOP** and report the block reason. Do not proceed.

## 3. What it can do

Inspect the code/manifest where available and list:

- Filesystem access — which paths it reads or writes.
- Shell / command execution — any `Bash` or PowerShell it runs, and when.
- Network access — which domains it contacts and what data it sends out.
- Declared permissions / `allowed-tools`.
- Any `postinstall` script or auto-run-at-install behavior.

Flag anything that executes code at install time or exfiltrates data.

## 4. Trust & supply chain

- Is the publisher known and reputable? Recent activity, downloads, stars?
- Is the source pinned (version/commit) or floating on a moving branch?
- Does it pull further dependencies of its own?

## 5. Verdict

Give exactly one:

- ✅ **safe to install**
- ⚠️ **install with caution** — list the conditions
- ⛔ **do not install** — list the reasons

Justify briefly. If the verdict is ✅ or ⚠️, end with the exact install command
to run, and remind the user it affects **every** session on this machine.
