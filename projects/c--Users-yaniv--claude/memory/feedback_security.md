---
name: feedback-security
description: "Security practices the user cares about — secrets, tokens, hardcoding"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7d84c854-8f9c-4429-b416-112d1abc564f
---

Flag hardcoded secrets immediately when spotted — even in settings files, permission patterns, or allow lists. Don't wait to be asked.

**Why:** Session revealed a live Replicate API token (`r8_...`) hardcoded inside the Claude Code `settings.json` allow list — visible to anyone who reads the file.

**How to apply:** When reading any config, settings, or permission file, scan for patterns like API tokens, passwords, or keys. Raise it as a 🚨 before continuing with other work. Recommend: rotate the token, store in Windows environment variables, reference via `$env:VAR`.
