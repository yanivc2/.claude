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

## Decision B — conditions (DECIDED 2026-07-16)

**Four conditions: A / C / D / B1 (relevance placebo).** Add B1 now; defer B2 (gate isolation).

- **A** — no-memory: solver attempts each test task fresh, no lessons.
- **C** — learned: per fold, the solver attempts the 18 train tasks and writes **gated**
  procedural lessons, tagged by semantic family → a **lesson-bank**; memory is then frozen and,
  for a held-out test task of family X, the bank's **family-X** lessons are injected.
- **D** — static playbook: a hand-written best-practice playbook (no learning) injected instead.
- **B1** — **relevance placebo**: for a test task of family X, inject the SAME lesson-bank's
  lessons but from a **different family Y≠X** (deterministic, frozen routing — e.g. the most-
  distant family in a fixed rotation). Identical text/length/structure/quality to C's
  injection — differs ONLY in relevance. B1 reuses C's bank, so it adds **no learning cost**,
  only evaluation (~+$0.7 for 27 test evals).

Rationale: the central validity threat is the "any extra text helps" confound (C>A might be
mere added context). B1 is the direct control: if C > B1 while B1 ≈ A, the **relevant learned
content** is what helps, not the presence of quality memory text. D controls a *different*
thing (learned vs generic-expert advice); it does not neutralize the text confound — only B1
does. **B2 (learned-without-gate)** answers a secondary question (does the write-gate improve
lesson quality) and is deferred to a follow-up, after C's content is shown to be the cause.

Placebo design (per user refinement): NOT randomly-scrambled lessons (that conflates
"irrelevant" with "harmful/confusing"), but **quality lessons from another family**. Because
B1 uses C's own bank mis-routed by family, text quality/length/structure are identical by
construction. Conservative property: if cross-family lessons partially generalize, B1 gets
partial help, making C>B1 *harder* to show — so a positive result is robust, not inflated.

## Decision C — context strategy (DECIDED 2026-07-16)

**Full target file, identical and content-hashed across all four conditions.** No region-only
in the main experiment.

Rationale: region-only injects new confounds — who picks the region? If from the reference
patch → **oracle leakage** (you've told the agent where the bug is). If via a model/retriever →
you now also measure retrieval quality, and the selector could help C more than A. Full file
gives every condition exactly the same information and leaves diagnosis inside the file to the
agent; the small extra cost is justified by validity.

**Scope declaration (honest):** §2 tests **file-given single-file repair** — the target file is
provided. It does **not** test repository navigation, file localization, or retrieval. Those
are deferred to a separate experiment. (Legitimate here because the corpus is already filtered
to single-file/near-single-hunk fixes.)

**Frozen & identical across A / B1 / C / D:**
- Same full target file (same content hash).
- **Same SANITIZED problem statement** (no solution / file-name / solution-identifier leak — via
  `corpus/sanitize.py`); never the raw issue text.
- **Hidden (F2P) tests are NEVER in the prompt** — two-zone isolation; only the verifier sees
  them. Prompt = buggy file + sanitized statement + public (P2P) tests only, same across
  conditions.
- Same problem statement, same prompt-component order, same context ceiling.
- Lessons injected at the same position and formatting in every condition; **only the lesson
  CONTENT differs** (none / family-relevant / other-family / static-playbook).
- If a file exceeds the context ceiling: either the task is pre-excluded, or one **deterministic**
  truncation strategy is applied **identically** to all conditions — never a manual region.

## Decision D — repetitions (DECIDED 2026-07-16)

**Do NOT pre-commit reps=2 for the full experiment. Use the micro-pilot to MEASURE
stability, then run the full 3-fold at reps=1 only if a stability gate passes.**

- **Micro-pilot: reps=2** on the ~9 tasks of one fold. Run each condition twice
  (A×2, B1×2, C×2, D×2) under byte-identical config: same model snapshot, thinking
  budget, temperature, context, prompt, verifier, max rounds, tool permissions. The
  pilot's purpose is NOT to estimate learning yet — only to answer: *does the same
  system, under the same inputs, return a stable pass/fail?*
- **Stability gate → admit reps=1 for the full run when ALL hold:**
  1. In **A** and in **C**, at most **1 per-task pass/fail flip out of 9** between the
     two reps. (Per-task flip count, NOT aggregate counts — 4/9 vs 4/9 can hide two
     cancelling flips.)
  2. The **sign of C−A does not reverse** between reps.
  3. No nondeterminism in the verifier or the test environment.
  4. Real cost stays inside the circuit-breaker ceiling.
- **If the pilot is stable:** run the full 3-fold at **reps=1**, and label it
  explicitly a **directional pilot**, not final proof. Justified because all 27 tasks
  already serve as held-out once, four conditions are already costly, a full repeat
  would double C's *learning* phase (not just evaluation), and the budget is tight.
- **If the pilot is NOT stable:** STOP and diagnose — do not blindly double the budget.
  Separate (1) **environment noise** (test timing / filesystem / dependency /
  nondeterministic verifier → fix the harness) from (2) **model randomness** (different
  patches under identical input → raise budget and run **all** conditions at equal reps).
  **Never give only C more repetitions** — that manufactures an unfair advantage.
- **Full replicate of C must relearn from scratch:** empty memory → learn the 18 train
  → emit a fresh lesson-bank → freeze → then evaluate held-out. Re-running *test-only*
  with the same bank measures **execution stability**, not **learning stability**.
- A positive full-run result still **requires independent replication before any strong
  claim** (deferred to follow-up).

### Keep-honest addenda to Decision D (do not override the decision; feed Decision E)

1. **The reps=1 gate is about EXECUTION stability, and that is the cheap axis.** The gate
   criteria (per-task flips in A and C, C−A sign) test whether *identical inputs* yield a
   stable pass/fail. Measuring that does **not** require relearning C's bank twice — it
   requires re-running the *evaluation* twice against the **same frozen bank** (plus A
   twice). The expensive double-relearn measures **learning** stability, which is exactly
   the "independent replication before a strong claim" already deferred — it is **not** a
   prerequisite for choosing reps=1. So the pilot's second rep should re-evaluate A and C
   on the held-out with C's bank frozen, not relearn it.
2. **Budget arithmetic — a naive pilot + full run overruns the $4.89 ceiling.** Counting
   ~$0.025/attempt: full 3-fold reps=1 = 3×(A9+B1·9+D9+C[18 learn+9 eval]) = 3×54 = **162
   attempts ≈ $4.05**. A pilot that re-runs all four conditions ×2 with C relearned each
   rep = 2×54 = **108 ≈ $2.70**; pilot+full = **270 ≈ $6.75 — over budget.** Even an
   A+C-only relearn pilot (72) overruns. **Feasible path (for Decision E):** run **fold 1
   first at reps=1** (54 attempts) and treat it as *both* the pilot base *and* official
   fold-1 data; add a **second execution-rep of A and C on fold-1's 9 held-out, bank
   frozen** (+18 ≈ $0.45) to get the flip-count gate; if it passes, continue folds 2–3 at
   reps=1 (+108). Total ≈ **180 attempts ≈ $4.50 — under ceiling.** This reuses the pilot
   instead of paying for it twice; it is only valid if the pilot config is byte-identical
   to fold 1 (which the pilot already requires).

## Decision E — OPEN

- E: run now vs expand the corpus first (given low power at n=27), and reconcile the
  budget path above.
