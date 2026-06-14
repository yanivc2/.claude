---
name: feedback-env-audit
description: /claude-env-audit skill is installed and should be used for periodic Claude Code environment health checks — not manually repeating the same audit steps each time.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7d84c854-8f9c-4429-b416-112d1abc564f
---

`/claude-env-audit` is installed at `~/.claude/skills/claude-env-audit.md`.

**Why:** Built during a comprehensive global environment improvement session where the same issues (stale allow list entries, hardcoded tokens in settings, broken Stop hooks) kept recurring. The skill captures all audit logic so future sessions don't re-derive it.

**How to apply:** When the user asks to audit, check, or clean up the global Claude Code environment — invoke `/claude-env-audit` rather than manually checking each file.

Architecture: 3 phases — SCAN (read-only), REPORT (severity-ranked), FIX (user-approved only).

Checks: security tokens in allow list, allow list quality (stale/redundant/too-broad), hooks health (agents in Stop hooks, git guards, PostToolUse TypeScript checker), CLAUDE.md completeness, memory system coverage, skills directory health.

Related: [[feedback-security]], [[feedback-typescript]]
