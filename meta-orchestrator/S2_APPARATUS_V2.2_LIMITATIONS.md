# §2 Apparatus v2.2 — Design Characteristics & Limitations

**Status: documentation only.** This file records how the §2 controlled-learning apparatus
(version v2.2) is actually built, so the eventual write-up can separate *the research question*
from *this particular implementation of it*. It changes **no** code, prompt, grading rule, or frozen
artifact, and has **no effect on any §2 result**. It is not a post-hoc justification: it is an honest
statement of which choices were pre-registered, which characteristics emerged during development, and
which questions a future protocol (v3) is intended to test.

---

## 1. Pre-registered decisions (fixed before the first paid dollar)

These were decided up front and frozen with hashes; each is enforced by the gate/anchor/grant chain
and by regression tests:

- **Grading is hidden, fail-on-buggy/pass-on-fixed (F2P).** `solver_outcome` is always
  hidden-based, never inferred from the public suite. The hidden verifier is never visible to the
  solver during an attempt; only the final workspace state is graded.
- **Task family taxonomy** (7 families) and the frozen `task_id -> family` map. The family label is
  never shown to the solver; it only routes the memory slot. The same routing wrapper is used for
  C / D / B1.
- **Deterministic, model-free write-gate** (the model proposes a candidate; code decides): train-only,
  verifier-PASS, schema-valid, provenance-referenced, leak-screened (no ids/paths/filenames/unique
  literals/concrete code), no `recommended_action`/`avoid` contradiction, family-dedup, and a
  per-family capacity of `MAX_ACTIVE_ENTRIES_PER_FAMILY = 2`. Held-out never writes.
- **Memory schema & renderer shared across C / D / B1**: `recommended_action` + `avoid`, label-free
  bullets, `SLOT_MAX_LINES = 8`, `SLOT_MAX_CHARS = 200`, deterministic truncation, no filler.
  **B1 receives exactly C's content**; only the family mapping differs.
- **Authoritative token-parity gate** for memory-bearing tasks (C vs B1 memory-only token gap;
  block iff `abs_gap > 32 AND rel_gap > 20%`), measured with real `count_tokens`.
- **Frozen model snapshot** `claude-haiku-4-5-20251001` (dated snapshot, not an alias), fixed
  endpoint/SDK, `max_retries=0` (no silent fallback), full observability (raw responses, usage,
  stop reasons, API errors).
- **Budget discipline**: frozen pricing, fold-1 cap $10 / global cap $50, per-task single-use
  execution grant + non-replayable ledger, atomic reserve→reconcile.
- **Context/output policy**: calibrated by `count_tokens` preflight (not an arbitrary number);
  no silent truncation/summarization/compaction; overflow is an error, not a partial attempt.
- **Final-round lifecycle (DEFECT-6 fix)**: once R2 opens it is the final round; a terminal R2
  yields `FAILED` with no hidden verify and no write-gate — never a silent fallback to R1's patch.

## 2. Apparatus characteristics that emerged during development (NOT the ideal design)

These are properties of *this* implementation that a cleaner design might choose differently. They
are disclosed here so the write-up does not present them as deliberate, optimal choices:

- **Sequential / feed-forward C-training.** Train tasks are run in condition C **with the
  accumulated bank injected** (a later whitespace task sees earlier whitespace lessons). This makes
  the bank's *composition* order-dependent and means the training solve-rates are not a clean
  memory-free base measurement. *(An ideal design would run all train tasks under a base no-memory
  contract, then distill the bank once — "batch distillation".)*
- **Extended thinking ON** (`thinking_budget = 1024`), which under the current API precludes a
  custom `temperature`. *(An ideal design might disable thinking and set `temperature = 0` to
  minimise non-treatment variance, keeping output budget for the patch.)*
- **Two-round R1/R2 SEARCH/REPLACE loop** (≤2 message calls per attempt), rather than a longer
  multi-round agentic loop with a full-file `write_source` tool and up to three
  patch→public-test→revise cycles.
- **Solver-proposed, SOLVE-only lesson candidates.** Lessons are proposed by the solver during its
  own attempt and banked only from SOLVED train tasks. *(An ideal design might use a dedicated
  lesson-writer with a filtered reference diff, learning from both successes and reference-contrasted
  failures.)*

**Why not change these now:** the apparatus was already built and the training sequence was already
running when these alternatives were considered. Changing the learning mechanism, agent contract, or
run parameters mid-sequence would turn this into a different experiment and would invalidate the
completed train attempts. The chosen discipline (see the working protocol) is: **do not alter a
frozen apparatus mid-sequence**; document the deviation instead.

## 3. Internal validity of the causal claim under these characteristics

The causal contrast is made at **held-out** evaluation, where every condition (A / C / D / B1) shares
the identical frozen apparatus and differs **only** in the memory slot. That contrast is internally
valid regardless of how the bank was built, as long as the bank uses **train data only** (no held-out
leakage) — which the write-gate's train-only rule and the fold-leakage tripwire enforce. The
sequential build affects the bank's *content* (a reproducibility/robustness caveat) and prevents
reporting a clean "train base solve-rate"; it does **not** undermine the held-out C−A estimand.

## 4. Questions deferred to a future protocol (v3)

A future, separate experiment (not an in-place upgrade of §2) is intended to test whether the
conclusions are robust to a cleaner apparatus:

- **Batch distillation** (base no-memory train pass, then a single per-family aggregation) vs the
  sequential feed-forward build used here.
- **`temperature = 0` with extended thinking disabled**, and a uniform thinking budget across all
  conditions if thinking is used at all.
- **A longer, uniform agentic contract** (semantic 4-round loop; ≤3 `write_source`, ≤3
  `run_public_tests`; full-file writes), identical across A / C / D / B1.
- **Reference-assisted lesson distillation** (dedicated lesson-writer with a filtered reference diff)
  learning from both successes and reference-contrasted failures.

v3 would be a fresh protocol version with its own freeze, its own gate/anchor/grant chain, and a
full re-run — never a mid-sequence modification of v2.2.

## 5. No effect on §2 results (explicit statement)

This document is descriptive. It does not modify the frozen bank, the memory-injection policy, the
write-gate, the agent contract, the pricing/budget artifacts, the training log, or the spend ledger.
The §2 outcomes stand exactly as recorded in `corpus/s2_official_training_log.json` and
`corpus/s2_paid_spend_ledger.json`. Any future change to the apparatus itself will, per the working
protocol, open a new protocol version and trigger invalidation + re-run — it will not be applied
retroactively to v2.2.
