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

## Decision E — run-now vs expand-first (DECIDED 2026-07-16)

**Sequential hybrid (ג).** Run §2 now on the 27 tasks as a **directional pilot**, stop and
interpret, and only THEN decide whether/how to expand — expansion must be a **response to a
defined pilot finding**, never a blind automatic activity. Budget is not the limiter for
expansion; the limiter is engineering/environment. The pilot uses the existing credit; a
confirmatory study gets a **separate** budget after empirical justification.

**Why n=27 is not a waste (what the pilot IS for).** It is the first real-world measurement of:
is there any headroom (or does A already almost always pass); does C produce *transferable*
lessons; does the agent actually *use* them; is C directionally > A and > B1; does C approach or
beat D; how many discordant pairs per comparison; how much the result swings across the 3 folds;
the *real* (not estimated) cost; the main failure reasons; and whether a mechanism validated so
far only with mocks works with a real model + real corpus. All valuable even with a wide CI and
no meaningful p-value.

**What the pilot may NOT claim.** Never "learning is proven in general." The only admissible
conclusion form: *"On Black formatting-repair tasks, in a file-given single-file configuration
with Haiku locked, a directional signal was / was not observed that relevant procedural memory
improves performance."*

**Statistical caveats (binding on the pilot report).**
- The 27 held-out results are **not 27 fully-independent observations**: the 9 tasks in a fold
  share C's single lesson-bank. Report the pooled paired table **and** each fold separately.
- Do **not** rely on McNemar alone; treat any p-value as **secondary** in the pilot.
- **Winner's curse:** a small-sample effect is biased upward. Do not design the next study as if
  the 27-task effect is the true effect — use a conservative assumption or a range of scenarios.

**Why NOT expand blind now.** Extra tasks cannot fix the three failure modes the pilot exists to
detect: (1) no headroom (A already near-ceiling); (2) no transfer (lessons don't help other
bugs); (3) application mechanism broken (lessons retrieved but ignored). In each, +30 tasks only
buy a more precise estimate of a **zero** effect. Expansion is also env/harness-blocked, would
raise model cost, and mixing in a new project conflates two questions (power vs cross-project
generalization). First learn which problem, if any, the pilot says is worth solving.

**Post-pilot decision tree (frozen — determines the next step, not the pilot itself):**
1. **Consistent positive signal** (C>A and C>B1 same direction; direction holds in ≥2/3 folds; C
   not carried by one family; lessons actually fire; no regressions; C approaches/beats D) →
   justified to expand and build a properly-powered **confirmatory** study.
2. **C>A but C≈B1** → no evidence the *relevant content* is the cause (could be added-text /
   prompt-structure). Do NOT expand; investigate the application mechanism and the placebo.
3. **C>A but C<D** → mechanism may learn but still loses to a hand-written playbook. Important,
   but not necessarily a corpus-expansion trigger; first resolve the product goal (learn without
   an expert vs beat a static expert playbook).
4. **C≈A while lessons ARE retrieved+applied** → likely too little transferable procedural
   knowledge inside Black-formatting; move to a **richer arena** rather than more-of-the-same.
5. **High instability** → fix noise/harness **before** any expansion.

**Corpus-size guidance (rules of thumb; real power analysis is computed FROM the pilot's paired
data, not from the raw difference):** 27→35 likely changes little; ~50–60 unique tasks is a
reasonable minimum to materially improve a *directional* pilot; a confirmatory study on a medium
effect plausibly needs ~80–120 tasks (depends on the shared-pair rate and effect size); per-family
claims need ≈10+ tasks per reported family, else family reporting stays descriptive only.

**Cost is for the FUTURE confirmatory budget, not a blocker now** (~6 model attempts/task = 4
evals + task appears twice in C-train): 27≈$4.05, 60≈$9, 80≈$12, 100≈$15 — excluding reps,
retries, stability runs, engineering qualification, and independent replication (replication may
double model cost). Hence: don't expand under the current credit; the pilot uses existing credit,
confirmatory gets separate budget after justification.

**External-validity ceiling (NOT fixed by more Black bugs).** Even at 100 Black bugs it is still:
one project, one formatting family, file-given, single-file repair, no navigation/localization,
Haiku-and-snapshot specific, with public-code contamination risk, and a D that may be influenced
by playbook-author identity. Cross-project generalization requires a **second project's corpus**
in future — not more Black.

**Fold-1-reuse pre-registration condition (critical).** Using fold 1 as *both* pilot and official
datum is valid ONLY if the continue-to-folds-2–3 decision is pre-declared as a function of
**stability, real cost, harness health, and circuit-breakers** — **never** of "does C look good."
If fold-1's effect is inspected and used to change prompts/thresholds/lessons/split/continue-
decision, fold 1 becomes **exploratory** and may not later be presented as part of a frozen clean
evaluation.

- **Keep-honest operationalization (added):** the continue/stop evaluator reads ONLY the
  {stability, cost, harness-health, circuit-breaker} signals; the **outcome table (C/A/B1/D
  pass-fail) is sealed** and not surfaced to any continue/stop logic (or to the operator's
  decision) until either all 3 folds complete or the run halts on a pre-declared stop trigger.
  The pilot's second execution-rep (Decision D's stability gate) runs on fold-1's A and C with C's
  bank **frozen** — no relearn — so it measures execution stability without becoming a learning
  replicate.

**Practical procedure (frozen):**
1. Freeze the analysis rules and the continue/stop rules **before** running (this doc + a
   pre-registration note).
2. Run fold 1 + the stability gate.
3. If the gate passes and real cost leaves a safety margin → complete folds 2–3 unchanged.
4. Report all 27 as a **directional pilot**.
5. Stop and interpret the four conditions.
6. Only then decide: expand the same corpus / move to a richer arena / stop (no signal to justify
   investment). **Do not expand now** — the pilot exists precisely to make any future expansion
   non-blind.

---

**§2 design is now fully specified (Decisions A–E frozen).** Next engineering step (gated on
explicit user approval + no paid API until approved): build the offline-testable A/C/D/B1 harness
over the 27-task frozen corpus with mocks, then a budget-capped micro-pilot on real Haiku, then
the 3-fold run — each behind its own go/no-go.

---

## Step 1 — offline mock harness (BUILT 2026-07-16, $0, no API)

Package `src/meta_orchestrator/experiment/s2/` + `tests/test_s2_harness.py` (23 tests) +
runner `examples/s2_offline_harness.py` → report `corpus/s2_offline_report.json`. Uses the
REAL Sandbox + composite verifier over tiny synthetic stand-in tasks; NO model, NO network.

What it wires and proves offline (all 12 invariants PASS, `self_checks_passed=true`):
- **Condition isolation** — only the injected memory slot varies (`memory.resolve_memory`);
  A empty, C=family-relevant, B1=other-family, D=static-playbook, identical rendered shape.
- **C lifecycle** — per fold: learn from the fold's train only → freeze bank → held-out
  injection with **no writes** (frozen bank raises `MemoryFrozenError`).
- **B1 placebo** — hash-locked family→other-family map, **no fixed point**, reuses C's own
  bank objects (identical length/schema; only relevance differs).
- **D** — content-hashed playbook with an `author_frozen` gate; the fixture is NOT frozen, so
  a real run is refused until an independent author freezes the real D.
- **Zero leakage** — hidden tests / reference fix / git are never in the agent's `TaskView`;
  a mis-routed or harmful lesson is **nullified by the verifier** (fails `no_forbidden_shortcuts`).
- **Zero cross-fold leakage** — fresh DB + fresh bank per fold.
- **Sealed outcomes** — `effect_table()` raises until `finalize()`; the continue/stop gate
  reads ONLY stability/cost/harness (sign-of-C−A exposed as a boolean, magnitude sealed).
- **Resume-safe** — idempotent run keys: re-running a fold adds no runs and no cost.
- **Balanced split** — 27 → **9/9/9** stratified folds, every task held-out exactly once.
- **Real-run guard** — a non-mock contract raises `RealRunBlocked` while the family map is
  SYNTHETIC or D is not author-frozen — the code cannot reach a paid API.

Preconditions still open before the micro-pilot (enforced by the guard, tracked as risks):
(1) replace the **SYNTHETIC** family map with the $0 `primary_sub_fingerprint`-derived map,
frozen; (2) an independent author writes + freezes the real **D**; (3) the synthetic stand-in
tasks are replaced by the real reproduced bugs (online, model-free). Awaiting user review of
`corpus/s2_offline_report.json` before any real API.

### Blocker 1 — real family map (CLOSED 2026-07-16)
`corpus/s2_family_map.json` is now `synthetic:false, frozen:true`, derived purely by
`primary_sub_fingerprint` (no manual mapping). 6 families (whitespace 9, iterator 7,
parser_normalization 4, other_logic 3, boundary 2, condition_inversion 2), folds **9/9/9**, zero
train-representation gaps. `content_hash=4171f399373b`, manifest `cee0c602…`, dataset commit
recorded. B1 placebo built over the 6 present families (hash-locked, no fixed point,
`map_hash=47f7e3b45ca0`). Generator: `examples/s2_build_family_map.py`.

### Blocker 2 — D authoring infrastructure (BUILT 2026-07-16; D itself NOT written)
Claude Code does **not** write D. `corpus/D_AUTHOR_PACKET.md` is the **blind** brief (goal,
scope, the 6 family names, tools, general verifier constraints, hard schema + size caps) — with
no task ids / statements / code / patches / hidden tests / per-bug results / future C lessons.
`experiment/s2/playbook_d.py` defines the schema (`trigger_or_context / recommended_action /
avoid / verification_step`) and a blind validator: schema + size caps + leak scan (rejects task
ids, paths, code, patches, concrete values) + the **shared slot budget** (`SLOT_MAX_LINES/CHARS`,
now enforced identically for C/B1/D in `render_lines`, so D gets no length/format edge). A clean
submission freezes into an **immutable** `StaticPlaybook` (`author_frozen=true`, content hash,
author provenance) via `examples/s2_validate_d.py`. 15 offline tests. **Next:** an independent
author (human or another model) receives only the packet and returns a submission; then validate
+ freeze. Real-bug wiring remains after that.
