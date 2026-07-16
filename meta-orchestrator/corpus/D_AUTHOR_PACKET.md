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

## 5. General verifier constraints (how a fix is graded — general, no specifics)

A fix passes only if ALL hold: the file still compiles; the change stays within **one** source
file; there are **no hard-coded / shortcut answers**; the test directories are left unmodified;
the public suite passes; and a **hidden** suite (never shown to the agent) also passes. Advice
that encourages narrow, honest fixes and self-checking against the public suite is on-target;
advice to "hardcode the expected output" is exactly what fails.

## 6. Hard schema (the validator enforces this exactly)

Return JSON matching this shape. Each family maps to **1–2 entries**; each entry has four fields:

```json
{
  "author": "<your name/handle>",
  "author_type": "human | model:<model-id>",
  "families": {
    "whitespace": [
      {
        "trigger_or_context": "<when this advice applies — general, no task names>",
        "recommended_action": ["<general step>", "<general step>"],
        "avoid": ["<general anti-pattern>"],
        "verification_step": "<one general check to run before finalizing>"
      }
    ],
    "iterator": [ ... ],
    "parser_normalization": [ ... ],
    "other_logic": [ ... ],
    "boundary": [ ... ],
    "condition_inversion": [ ... ]
  }
}
```

### Size limits (to match condition C's memory slot — no length/format advantage)

- ≤ **2** entries per family.
- ≤ **3** items in `recommended_action`; ≤ **3** items in `avoid`.
- ≤ **200** characters per field.
- After rendering (actions + a `verify:` line + `avoid:` lines), ≤ **8** bullet lines per family.
- `trigger_or_context` is for your organization; it is **not injected** into the agent's prompt
  (mirroring how condition C's triggers are not injected) — only the actions, the verify line,
  and the avoids are shown, in the same bullet format as C.

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
