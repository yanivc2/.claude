# D authoring process (operator runbook, FROZEN 2026-07-16)

How the condition-D static playbook gets written, checked, and frozen. This is the **operator's**
document — not the author's. The author receives only `D_AUTHOR_PACKET.md` + `D_SUBMISSION_SCHEMA.json`.

## Who may author D (independence, ranked)

1. **A model from a different provider** (e.g. GPT, Gemini) — preferred. Lowest shared prior with
   Claude Code (which built the corpus, the schema, and will produce C's lessons).
2. **An experienced Python developer** who has not seen the corpus.
3. **A different Claude model, in a separate clean session with no project access** — weakest for
   independence; use only if 1–2 are impossible.

**Recommended:** GPT in a fresh, clean session, given only the packet — no project history, no
extra rationale beyond the packet.

## Who may NOT author D

Anyone already exposed to too much: Claude Code; the Claude Chat that co-designed this; any model
that received the status docs or qualification reports; any person involved in mining the bugs or
labelling the families. The reason is exposure, not competence.

## What the author MAY be given

- `D_AUTHOR_PACKET.md` (approved) and `D_SUBMISSION_SCHEMA.json` (empty template).
- Nothing else. The packet already states what they may know: the domain is Black formatting
  repair; the target file is given; single-file repair; the six family **names** only; the agent's
  tools; that the fix must pass an independent verifier; the schema and length limits.

## What the author MUST NOT be given

Repository / branch; any GitHub or corpus link; `STATUS_AND_QUESTIONS.md` or any status doc; the
list of 27 tasks; task ids; problem statements; reference patches; commit messages; hidden or
public tests; the family distribution (e.g. `whitespace=9`); the fold split; qualification
results; baseline results; C's lessons; sample playbooks; explanations of failed bugs; or the
history of our heuristics discussions. **No content hints** — not even "the system tends to fail
on iterator" or "check normalization" (those are corpus-derived hints).

## No internet

The author must not browse or search — not Black, not PyBugHive, not old issues/patches/known
failure modes. Instruction: *"Use only the packet and your own general knowledge. Do not browse,
do not search PyBugHive or Black issues, do not ask for more files."*

## Output format

Schema-only JSON (or YAML) matching `D_SUBMISSION_SCHEMA.json` — no explanations, analysis,
reasoning, comments, or suggestions about the experiment. `author_type` / `author_name` are
metadata and are kept OUT of the injected content (they never spend the slot budget).

## Validation + freeze (operator)

1. Run `python examples/s2_validate_d.py <submission.json> [--attest-independent]`.
2. **On failure:** return to the author ONLY the technical schema/validation messages the script
   prints (e.g. "too many entries", "field too long", "disallowed token"). Never a content hint.
   Do NOT hand-edit the author's advice — the author revises and resubmits.
3. **On pass:** the script freezes `corpus/d_playbook.frozen.json` with author metadata, a content
   hash, and `author_frozen=true` (the model is immutable). Record author independence via
   `--attest-independent`.
4. The harness real-run guard already refuses to run until D is author-frozen.

## Order

`real family map ✅ → blind D packet ✅ → independent authoring + freeze (this step) → wire the 27 real bugs`
