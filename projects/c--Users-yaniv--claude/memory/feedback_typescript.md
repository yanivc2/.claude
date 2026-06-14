---
name: feedback-typescript
description: TypeScript verification habit — always run tsc before reporting done
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7d84c854-8f9c-4429-b416-112d1abc564f
---

Always run `tsc --noEmit` before reporting a TypeScript task as complete.

**Why:** In the api-demo-video session, multiple edit/fix cycles happened because TypeScript errors (unused imports, wrong type names like `StatCardData` vs `StatData`) were only caught after reporting done.

**How to apply:** After any edit to `.ts`/`.tsx` files, run `npx tsc --noEmit` in the project root. If it fails, fix before responding. A PostToolUse hook now does this automatically — but still verify manually at the end of a task.
