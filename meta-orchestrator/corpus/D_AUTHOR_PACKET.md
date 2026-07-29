# D_AUTHOR_PACKET — blind brief for the static playbook (condition D)

You are an **independent author** writing a static best-practice playbook for an automated
Python bug-fixing agent. This is the only material you receive. **You must not be shown, and
must not ask for, any of the actual bugs, their code, their fixes, or any per-task result.**
Write general procedural advice only, from your own expertise.

> Do not look up, guess, or reference any specific bug, repository issue, file, or test. If you
> find yourself naming a concrete case, delete it — that is a leak and the validator will reject it.

---

## 1. Experiment goal (context only)

We compare, on unseen tasks, a **learned** procedural memory against (a) **no memory** and
(b) **this static playbook you are writing**. Your playbook is the "expert wrote it once,
ahead of time, without seeing the tasks" baseline. It should be genuinely useful general
advice — not padding, not vague filler — but it cannot depend on any specific task.

## 2. Scope of the agent's task

- The agent fixes **formatting bugs in the Black code formatter** (Python).
- It is **given the single target file** to repair — no repository navigation, no file search.
- It performs **single-file repair**: the fix lives in one source file.
- It sees the buggy source and the **public** tests; it never sees the hidden tests used to grade.

## 3. The six semantic families (names only)

Write advice bucketed by these families. These are the *only* buckets; names only — no examples
from the corpus:

- `whitespace`
- `iterator`
- `parser_normalization`
- `other_logic`
- `boundary`
- `condition_inversion`

Provide advice for **every** family listed. Keep each family's advice about *that kind* of
formatting change in general terms.

## 4. Tools available to the agent (so your advice is actionable)

- `read_source(path)` — read a source file it is allowed to see.
- `read_public_tests()` — read the public test suite.
- `write_source(path, content)` — write ONLY the given source file.
- `run_public_tests()` — run the public suite (this is the agent's own check, not the grader).

## 5. General verifier constraints (the rules of the game — general, no specifics)

A fix is graded by an **independent verifier that the agent cannot see or change**. The file must
still compile, the change must stay within **one** source file, the test directories must be left
unmodified, the public suite must pass, and a **hidden** suite (never shown to the agent) must
also pass. **The final patch must satisfy the independent verifier and may not modify or bypass
tests, validation logic, or evaluation controls.**

## 6. Hard schema (the validator enforces this exactly)

Return JSON matching this shape — a flat `entries` list, **1–2 entries per family**, covering all
six families. Each entry has: `family`, `trigger_or_context` (organizational, **not injected**),
`recommended_action`, `avoid`. Author metadata (`author_type`, `author_name`) is provenance only
and is **never** shown to the agent.

```json
{
  "author_type": "external_model | external_human",
  "author_name": "<your name/handle — metadata only, never injected>",
  "entries": [
    {
      "family": "whitespace",
      "trigger_or_context": "<when this advice applies — general, no task names>",
      "recommended_action": ["<general step>", "<general step>"],
      "avoid": ["<general anti-pattern>"]
    }
  ]
}
```

Include entries for every family: `whitespace`, `iterator`, `parser_normalization`,
`other_logic`, `boundary`, `condition_inversion`.

If you have a verification tip, **fold it into `recommended_action`** as an ordinary step (e.g.
"run the public suite once before finalizing"). There is deliberately no separate verification
field — the injected format is exactly the same as the learned condition's: actions + avoid.

### Size limits (identical to the learned condition's memory slot — no length/format advantage)

- ≤ **2** entries per family.
- ≤ **3** items in `recommended_action`; ≤ **3** items in `avoid`.
- ≤ **200** characters per field.
- After rendering (actions + `avoid:` lines), ≤ **8** bullet lines per family.
- `trigger_or_context` is for your organization; it is **not injected** into the agent's prompt
  (mirroring how the learned condition's triggers are not injected) — only the actions and the
  avoids are shown, in the same bullet format.

## 7. Forbidden content (auto-rejected by the validator)

Anything that could only come from seeing the tasks or their solutions:

- task / issue / repository ids (e.g. `project-1234`);
- specific problem statements or code from the tasks;
- reference patches, diffs, or file paths / filenames (`.py`, `/`);
- hidden test contents or concrete expected values / assertions;
- per-bug qualification results;
- anything copied from lessons the learned system will later produce.

Keep every field to **general** procedural advice. Submit the JSON; the validator checks schema,
size, and leaks, then freezes it with a content hash and `author_frozen=true`. After freeze the
playbook is immutable and cannot be edited.

## 8. How to respond (rules for your submission)

- Use **only this packet and your own general knowledge**. **Do not** use the internet, and do
  not search for Black, PyBugHive, its issues, patches, or known failure modes. Do not ask for
  additional files or data.
- Return **schema-only JSON** matching section 6 — **no** prose, reasoning, commentary,
  explanations, or suggestions about the experiment. Anything outside the JSON is discarded and
  may cause rejection.
- Cover all six families, 1–2 entries each, within the size limits.
- If your submission is rejected, you will receive only a short **technical** schema/validation
  message (e.g. "too many entries", "field too long", "disallowed token"). Revise and resubmit;
  you will not be given any hint about the tasks or expected content.
