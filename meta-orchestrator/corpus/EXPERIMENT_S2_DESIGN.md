# §2 Learning Experiment — Design Decisions (accumulating, frozen per decision)

Goal: prove that a **learned** procedural policy (C) generalizes to **unseen** tasks better
than (A) no-memory and (D) a static hand-written playbook — on the 27 qualified black
formatting bugs (manifest `pybughive_gate1_manifest.json`, sha256 `cee0c602…`). Reporting is
by the **semantic primary-sub taxonomy** (GATE1 decision), never the legacy exception label.

Grounded budget facts: median target file ~20k tokens (black.py ~2500 lines); Haiku
~$0.025/attempt (whole-file context); credit ~$4.89.

---

## Decision A — evaluation split (DECIDED 2026-07-16)

**3-fold stratified cross-validation** (stratified by semantic primary-sub family), **not** a
single 18/9 split.

- 27 tasks → 3 folds of 9, stratified so families are balanced across folds.
- Each round: 18 train / 9 test, disjoint. The learned condition C is **retrained from scratch
  per fold** on that fold's 18 train tasks, then its memory is frozen and evaluated on the 9
  held-out test tasks. A (no-memory) and D (static playbook) are stateless — evaluated on the
  held-out test tasks directly.
- Every one of the 27 tasks serves as held-out test exactly once (across the 3 folds).
- **Report both** the pooled result (all 27 as-test) **and** per-fold results (to expose
  instability — a 5/9 vs 7/9 swing on n=9 is 2 tasks).
- Stop at 3-fold: LOO / 9-fold are too costly for this stage.

Rationale: n=27 is small; a single 9-task test wastes information and its generalization
estimate swings on 2 tasks. 3-fold uses all 27 for evaluation while keeping train/test disjoint
per fold.

**Linked cost consequence (open, feeds Decisions D/E):** 3-fold triples the C learning phase
(3×18 = 54 learning attempts) + A/C/D evaluation over all 27 ≈ ~135 attempts ≈ **$3–5**, close
to the $4.89 ceiling. This constrains reps (Decision D), context strategy (C), and the
micro-pilot-first plan (E) — to be resolved in those decisions.

## Decisions B–E — OPEN

- B: conditions (A/C/D sufficient, or add a B condition, e.g. learned-without-gate?)
- C: context strategy (whole target file vs region-only)
- D: repetitions & max rounds (budget vs signal stability)
- E: micro-pilot-first + whether to expand the corpus before spending, given low power
