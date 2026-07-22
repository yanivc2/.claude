# v3 Pre-Registration DRAFT (not yet in force — thresholds finalize before any paid call)

DRAFT. A v3 paid micro-pilot may begin only after this document is finalized + frozen and a new
budget is approved. Nothing here authorizes spending.

## Gate A — output-contract validity (no memory) — THRESHOLDS FROZEN 2026-07-22

- **Design (frozen):** the 9 fold-1 held-out tasks (including cookiecutter-18 — its C/B1 parity
  block is irrelevant here: no memory, no C/B1), A-condition only, two arms OLD (frozen v2.2
  SEARCH/REPLACE) vs NEW (v3 JSON unique-anchor) + one bounded malformed/truncated repair-retry.
  9 tasks × 2 contracts = **18 cells**, paired by task. Manifest `v3_gate_a_manifest.json`
  (content_hash `167338c4d7a7ae7d`); balanced first-contract order alternating by task.
- **Held constant (both arms):** model claude-haiku-4-5-20251001, thinking_budget 1024,
  max_tokens 11264, context, materialization, public+hidden tests, round lifecycle. thinking is
  NOT changed in Gate A (a thinking-off study is a separate future gate). ONLY the output
  contract varies.
- **Primary metric:** VALID_APPLIED_PATCH (complete + schema-valid + anchors resolve uniquely +
  edits apply atomically + resulting files still parse). Public/hidden solve is secondary.
- **Harness-side thresholds — already MET offline** (`tools/v3_output_contract_prototype.py`,
  13 tests): parser acceptance on well-formed 100%; ambiguous application 0%; silent partial 0%;
  deterministic replay 100%.
- **FROZEN model-side Go classification (9 tasks/arm; decided before the first paid call):**
  ```
  PASS  (proceed to plan Gate B):    ALL of
        NEW valid-applied            >= 8/9
        NEW malformed/no-apply       <= 1/9
        NEW − OLD valid-applied      >= 3/9 tasks
        silent partial applications   = 0
        ambiguous applications accepted = 0
        deterministic replay failures = 0
  BORDERLINE (do NOT start Gate B; analyse format failures, decide re-pilot or close):
        NEW = 7/9 valid-applied
        OR   NEW >= 8/9 but NEW − OLD improvement is only 1–2 tasks
  FAIL / NO-GO (close this v3 contract direction or design another; no "fix in flight", no Gate B):
        NEW valid-applied            <= 6/9
        OR any silent partial application
        OR any non-deterministic replay
        OR any accepted ambiguous anchor
        OR no improvement over OLD
  ```
  No statistical significance is required at Gate A — it is a small engineering gate with
  pre-set acceptance criteria.

### Gate A budget (frozen)

```
V3_GATE_A_HARD_CAP = $1.00   (separate, Gate-A-only; does not authorize spending by itself)
```
Before any SEND-GO the prep must report: exact expected cost, exact sum-of-cell worst-case
exposure, current provider-reported credits, global lifetime spend including v2.2, and headroom
under the $50 global cap. The frozen per-cell credit rule applies: if reported credits do not
cover at least the next cell's worst-case exposure, STOP. thinking / tokens / tasks / safeguards
are never reduced to fit a balance.

## Gate B — learning (only if Gate A passes)

- **Design:** conditions A / C / D / B1 under the robust contract; C trained via the separated
  solver→verifier→distiller pipeline with two-tier routing; held-out evaluation; sealed outcomes;
  one-shot deterministic unseal under a v3 blinded analysis plan.
- **Primary estimand:** Δ(C−A) at task level (unit = task), exact paired McNemar/sign test, frozen
  before unseal — identical statistical machinery to v2.2's plan.
- **Sample:** enough held-out tasks for the paired test to have power (see V3_COST_AND_POWER_PLAN.md);
  fold-1's 8 is a pilot floor, not a target.
- **Claim discipline:** directional pilot unless a properly-powered confirmatory run is separately
  pre-registered; cross-fold / cross-project generalization stays NOT_ESTABLISHED until tested.

## Invariants carried from v2.2 (non-negotiable)

Hidden F2P is the primary outcome; public never is. Token parity for C vs B1. Label-free
injection + condition-label fail-closed. Single-use grants + atomic budget + frozen pricing/caps.
Sealed outcomes + pre-frozen analysis plan + deterministic one-shot unseal. Train-only,
leak-screened, capped write-gate. No silent fallback. v2.2 results/bank remain immutable.

## What finalizing this draft requires

Operator sign-off on the model-side Gate-A thresholds; a funded budget; a frozen v3 manifest +
apparatus-version hash; and a v3 blinded analysis plan (mirroring S2_FOLD1_BLINDED_ANALYSIS_PLAN.md).
