# §2 Working Protocol (persistent operating rules)

Durable rules for how to run the §2 learning-experiment work, written down so they survive context
compaction and fresh sessions. Kept OUTSIDE the sealed handoff critical-file set
(`corpus/`, `examples/`, `tests/`, `src/…/s2/`) on purpose, so adding/updating it never reopens the
handoff bundle. Explanations to the user are in Hebrew; this file (a tracked artifact) is English.

## 1. Consultation block at EVERY stop — automatic, unprompted
At every stop / decision / approval point, produce a copy-paste **consultation block for GPT**
WITHOUT being asked. The block must be self-contained and include:
1. a short summary of progress since the previous block;
2. the specific decision/question, stated INSIDE the block;
3. enough context that GPT (no repo access, no memory) can answer.
GPT's answers are **consultation only, not decisions** — retain independent keep-honest judgment
and flag anything GPT gets wrong (e.g. hallucinated facts, a check that passes without proving the
property).

## 2. Nothing paid / networked without explicit human sign-off
Do NOT stand up the pilot environment, install the pinned SDK, use an API key, make any network
call, run real `count_tokens`, run a real Gate 1, or make ANY paid Messages call without the user's
explicit approval at that step. Everything remains `$0` / offline until then. Budget stays `< $5`
until a real `count_tokens` cost projection justifies more — and then ask for a specific amount.

## 3. Never expose or persist secrets
Never paste the API key into chat. Never write an API key / auth header / hidden-test datum into any
tracked file or artifact. Secrets live only in the environment (e.g. `META_ORCH_API_KEY`).

## 4. Keep the sealed handoff bundle intact
The handoff bundle (`corpus/S2_PILOT_HANDOFF_MANIFEST.json` + `.sha256`) and every critical file it
inventories are frozen. Do not edit a critical file, the manifest, or the seal casually — any such
change reopens the bundle and requires a conscious rebuild + re-verify. Non-critical additions (like
this file) are safe. After any change near the bundle, run `examples/s2_verify_handoff.py` and
confirm exit 0.

## 5. Commit / push discipline
Develop on the designated feature branch. Commit with clear Conventional-Commit-style messages.
Do not commit or push without an explicit request. `main` is protected.

## 6. Chat language
Explanations to the user are in Hebrew. Code, identifiers, commit messages, and tracked artifacts
stay in English. Do not put the model identifier into commits/PRs/code/artifacts — chat only.
